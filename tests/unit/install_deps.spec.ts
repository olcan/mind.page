import { expect, test } from '@playwright/test'
import { autodepParent, labelPrefixes, type AutodepDeps, type LocalAncestor } from '../../src/install_deps.js'

// schedules for the install-time autodep parent (see src/install_deps.ts). the runtime graph
// (itemDeps) adds a label-prefix parent as first dependency for autodep items, with the flag
// inherited from uniquely labeled ancestors (the carrier's own tag applies to its descendants,
// never to itself, 2026-09-27); the install loops historically walked text tags
// only, and this module is what closes the installed closure over that edge. these tests pin the flag walk
// (own tags, local ancestors, repo ancestors, ambiguity), the parent resolution, and the
// at-most-one-fetch-per-tag contract

function harness(opts: { local?: Record<string, LocalAncestor>; repo?: Record<string, string[]> } = {}) {
  const fetches: string[] = []
  const deps: AutodepDeps = {
    local: tag => opts.local?.[tag] ?? null,
    fetchRawTags: async tag => {
      fetches.push(tag)
      return opts.repo?.[tag] ?? null
    },
  }
  return { deps, fetches }
}

test('label prefixes run longest to shortest, none for a top-level label', () => {
  expect(labelPrefixes('#a/b/c')).toEqual(['#a/b', '#a'])
  expect(labelPrefixes('#a')).toEqual([])
})

test('a top-level label has no parent and fetches nothing', async () => {
  const { deps, fetches } = harness({ repo: { '#a': ['#_autodep'] } })
  expect(await autodepParent(deps, '#a', ['#_autodep'])).toBe(null)
  expect(fetches).toEqual([])
})

test('an own #_autodep tag installs no parent: the tag applies to the descendants', async () => {
  const { deps, fetches } = harness({ repo: { '#a/b': [], '#a': [] } })
  expect(await autodepParent(deps, '#a/b/c', ['#x', '#_autodep'])).toBe(null)
  expect(fetches).toEqual(['#a/b', '#a']) // the ancestors' tags decide; none carries it
})

test('the flag inherits from the immediate parent repo text', async () => {
  const { deps, fetches } = harness({ repo: { '#a/b': ['#_autodep'] } })
  expect(await autodepParent(deps, '#a/b/c', [])).toBe('#a/b')
  expect(fetches).toEqual(['#a/b']) // one fetch serves both the flag walk and the parent lookup
})

test('the flag inherits through a missing intermediate from a repo grandparent', async () => {
  // the parent itself is installable, so the closure recursion converges the runtime flag
  const { deps, fetches } = harness({ repo: { '#a': ['#_autodep'], '#a/b': [] } })
  expect(await autodepParent(deps, '#a/b/c', [])).toBe('#a/b')
  expect(fetches).toEqual(['#a/b', '#a'])
})

test('a repo miss at the immediate parent closes repository discovery', async () => {
  // recursion cannot install a level with no repo file, so the tagged grandparent behind it
  // could never become local — it is not even fetched
  const { deps, fetches } = harness({ repo: { '#a': ['#_autodep'] } })
  expect(await autodepParent(deps, '#a/b/c', [])).toBe(null)
  expect(fetches).toEqual(['#a/b'])
})

test('a repo miss mid-chain closes discovery behind a repo-present parent', async () => {
  // the parent would install, but its own recursion stops at the missing middle level, so the
  // tagged top ancestor never becomes local and the parent would not be a runtime dependency
  const { deps, fetches } = harness({ repo: { '#a/b/c': [], '#a': ['#_autodep'] } })
  expect(await autodepParent(deps, '#a/b/c/d', [])).toBe(null)
  expect(fetches).toEqual(['#a/b/c', '#a/b'])
})

test('a locally installed false middle closes repository discovery behind it', async () => {
  // recursion skips installed levels, so the repo-only tagged ancestor behind the installed
  // (non-autodep) middle could never become local — discovery closes without fetching it
  const { deps, fetches } = harness({
    local: { '#a/b': { autodep: false } },
    repo: { '#a/b/c': [], '#a': ['#_autodep'] },
  })
  expect(await autodepParent(deps, '#a/b/c/d', [])).toBe(null)
  expect(fetches).toEqual(['#a/b/c'])
})

test('a locally installed autodep parent is returned without any fetch', async () => {
  const { deps, fetches } = harness({ local: { '#a/b': { autodep: true } } })
  expect(await autodepParent(deps, '#a/b/c', [])).toBe('#a/b')
  expect(fetches).toEqual([])
})

test('a local non-autodep ancestor answers the flag walk without a repo fetch', async () => {
  // runtime fidelity: the local flag already incorporates that item's own ancestors, so the
  // repo is not consulted behind it — even when the repo text carries the tag
  const { deps, fetches } = harness({
    local: { '#a/b': { autodep: false }, '#a': { autodep: false } },
    repo: { '#a': ['#_autodep'] },
  })
  expect(await autodepParent(deps, '#a/b/c', [])).toBe(null)
  expect(fetches).toEqual([])
})

test('an ambiguous local ancestor closes repository discovery behind it', async () => {
  // runtime ignores non-unique labels and recursion cannot traverse them, so the repo-only
  // tagged grandparent behind the ambiguous parent is never fetched
  const { deps, fetches } = harness({
    local: { '#a/b': 'ambiguous' },
    repo: { '#a': ['#_autodep'], '#a/b': [] },
  })
  expect(await autodepParent(deps, '#a/b/c', [])).toBe(null)
  expect(fetches).toEqual([])
})

test('a local autodep ancestor past an ambiguous boundary still resolves the parent', async () => {
  // boundaries close repository discovery only: the runtime inherits from an already-installed
  // unique ancestor across the gap, and the repo-present immediate parent can join the graph
  const { deps, fetches } = harness({
    local: { '#a/b': 'ambiguous', '#a': { autodep: true } },
    repo: { '#a/b/c': [] },
  })
  expect(await autodepParent(deps, '#a/b/c/d', [])).toBe('#a/b/c')
  expect(fetches).toEqual(['#a/b/c'])
})

test('own #_autodep with an installed parent that is not autodep installs nothing', async () => {
  // the item's own tag counts for its descendants only; the installed parent's flag (false:
  // it neither carries nor adopts) decides, no fetch
  const { deps, fetches } = harness({ local: { '#a': { autodep: false } } })
  expect(await autodepParent(deps, '#a/b', ['#_autodep'])).toBe(null)
  expect(fetches).toEqual([])
})

test('a rejected fetch rejects the walk instead of resolving absence', async () => {
  const deps: AutodepDeps = {
    local: () => null,
    fetchRawTags: async () => {
      throw new Error('github 500')
    },
  }
  await expect(autodepParent(deps, '#a/b/c', [])).rejects.toThrow('github 500')
})

test('no flag anywhere resolves nothing after fetching each absent ancestor once', async () => {
  const { deps, fetches } = harness({ repo: { '#a/b': ['#x'], '#a': [] } })
  expect(await autodepParent(deps, '#a/b/c', ['#y'])).toBe(null)
  expect(fetches).toEqual(['#a/b', '#a'])
})

// parent tags (review 2 C5): a level's tree override, what the seam can and cannot decide

test('an installed chat named by the parent tag of a repo-only parent decides its adoption; the carrier is not fetched', async () => {
  // #p/plan-b (repo-only) is renamed under the local chat #p/0/0, which adopts its carrier: the
  // child adopts #p/plan-b, the parent to install; neither #p/0/0 nor #p is fetched
  const { deps, fetches } = harness({
    local: { '#p/0/0': { autodep: true, chat: true }, '#p': { autodep: false } },
    repo: { '#p/plan-b': ['#p/plan-b', '#_p/0/0'] },
  })
  expect(await autodepParent(deps, '#p/plan-b/0', [])).toBe('#p/plan-b')
  expect(fetches).toEqual(['#p/plan-b'])
})

test('a repo-only ancestor naming a local non-chat import takes no override: the textual walk continues', async () => {
  const { deps, fetches } = harness({
    local: { '#util/core': { autodep: false, chat: false }, '#p': { autodep: false } },
    repo: { '#p/x': ['#p/x', '#_util/core'] },
  })
  expect(await autodepParent(deps, '#p/x/0', [])).toBe(null)
  expect(fetches).toEqual(['#p/x'])
})

test('an unknown target beside a local chat candidate declines the adoption (review 2 C5)', async () => {
  // #p/name names a local chat carrier AND a repo-only #p/remote, which could be a second chat
  // candidate once installed: no guess, no parent, the runtime decides after #p/name is installed
  const { deps, fetches } = harness({
    local: { '#p/local': { autodep: true, chat: true }, '#p': { autodep: false } },
    repo: { '#p/name': ['#p/name', '#_p/local', '#_p/remote'], '#p/remote': ['#p/remote', '#_chat'] },
  })
  expect(await autodepParent(deps, '#p/name/0', [])).toBe(null)
  expect(fetches).toEqual(['#p/name']) // the unknown target is not classified by a fetch
})

test("the item's own parent tag naming a local chat installs nothing more; naming an unknown declines", async () => {
  const known = harness({ local: { '#p/0/0': { autodep: true, chat: true }, '#p': { autodep: true } } })
  expect(await autodepParent(known.deps, '#p/plan-b', ['#p/plan-b', '#_p/0/0'])).toBe(null) // the tag parent is a text dependency already
  expect(known.fetches).toEqual([])
  const unknown = harness({ local: { '#p': { autodep: true } }, repo: { '#p/0/0': ['#p/0/0'] } })
  expect(await autodepParent(unknown.deps, '#p/plan-b', ['#p/plan-b', '#_p/0/0'])).toBe(null) // declined, the textual carrier notwithstanding
  expect(unknown.fetches).toEqual([])
})

test('a target nested under the level, an out-of-root chat and a textual parent are no overrides', async () => {
  const { deps, fetches } = harness({
    local: {
      '#p/a/b': { autodep: false, chat: true },
      '#chat/vault': { autodep: true, chat: true },
      '#p': { autodep: false, chat: false },
    },
    repo: { '#p/a': ['#p/a', '#_p/a/b', '#_chat/vault', '#_p'] },
  })
  expect(await autodepParent(deps, '#p/a/c', [])).toBe(null)
  expect(fetches).toEqual(['#p/a'])
})

test('a repo-only override to a local chat without a carrier adopts nothing', async () => {
  const { deps, fetches } = harness({
    local: { '#p/known': { autodep: false, chat: true }, '#p': { autodep: true } },
    repo: { '#p/a': ['#p/a', '#_p/known'] },
  })
  expect(await autodepParent(deps, '#p/a/x', [])).toBe(null) // the ancestry continues at #p/known, whose ancestry carries nothing
  expect(fetches).toEqual(['#p/a'])
})

// review 3 B5: the facts the seam already knows

test("an ancestor's own carrier counts before its override (a child adopts the carrier whatever the carrier's place)", async () => {
  const { deps, fetches } = harness({
    local: { '#p/known': { autodep: false, chat: true }, '#p': { autodep: false } },
    repo: { '#p/a': ['#p/a', '#_p/known', '#_autodep'] },
  })
  expect(await autodepParent(deps, '#p/a/x', [])).toBe('#p/a')
  expect(fetches).toEqual(['#p/a'])
  // the same with the carrier's target unknown: the carrier decides, nothing is declined
  const unknown = harness({ local: { '#p': { autodep: false } }, repo: { '#p/a': ['#p/a', '#_p/remote', '#_autodep'] } })
  expect(await autodepParent(unknown.deps, '#p/a/x', [])).toBe('#p/a')
})

test("a unique local ancestor's negative flag is final: no shorter textual carrier behind it", async () => {
  // #p/c/x is renamed under a chat whose ancestry carries nothing, so its descendants adopt
  // nothing although #p/c, its textual parent, carries the tag
  const { deps, fetches } = harness({
    local: { '#p/c/x': { autodep: false, chat: true }, '#p/c': { autodep: true }, '#p': { autodep: false } },
    repo: { '#p/c/x/new': ['#p/c/x/new'] },
  })
  expect(await autodepParent(deps, '#p/c/x/new/0', [])).toBe(null)
  expect(fetches).toEqual(['#p/c/x/new'])
})

test('a local item labeled like a special tag is a real candidate: two chats, no override', async () => {
  const { deps, fetches } = harness({
    local: { '#p/local': { autodep: true, chat: true }, '#log': { autodep: false, chat: true }, '#p': { autodep: false } },
    repo: { '#p/name': ['#p/name', '#_p/local', '#_log'] },
  })
  expect(await autodepParent(deps, '#p/name/0', [])).toBe(null)
  expect(fetches).toEqual(['#p/name'])
})

test('a unique local target nested under the level blocks its override, and the textual walk decides (review 4 B3)', async () => {
  // #p/r names a chat beside its own nested #p/r/notes: a nesting cycle blocks the override, so
  // #p/r adopts its textual parent #p, the carrier, which the install must include
  const { deps, fetches } = harness({
    local: { '#p/known': { autodep: false, chat: true }, '#p/r/notes': { autodep: false, chat: false } },
    repo: { '#p': ['#p', '#_chat', '#_autodep'] },
  })
  expect(await autodepParent(deps, '#p/r', ['#p/r', '#_p/known', '#_p/r/notes'])).toBe('#p')
  expect(fetches).toEqual(['#p'])
  // the nested target absent: unknown, declined; ambiguous: no target at all, the override stands
  const absent = harness({ local: { '#p/known': { autodep: false, chat: true }, '#p': { autodep: true } } })
  expect(await autodepParent(absent.deps, '#p/r', ['#p/r', '#_p/known', '#_p/r/notes'])).toBe(null)
  const ambiguous = harness({ local: { '#p/known': { autodep: false, chat: true }, '#p/r/notes': 'ambiguous', '#p': { autodep: true } } })
  expect(await autodepParent(ambiguous.deps, '#p/r', ['#p/r', '#_p/known', '#_p/r/notes'])).toBe(null) // the override to #p/known: nothing to install
})
