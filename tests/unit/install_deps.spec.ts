import { expect, test } from '@playwright/test'
import { autodepParent, labelPrefixes, type AutodepDeps, type LocalAncestor } from '../../src/install_deps.js'

// schedules for the install-time autodep parent (see src/install_deps.ts). the runtime graph
// (itemDeps) adds a label-prefix parent as first dependency for autodep items, with the flag
// inherited from uniquely labeled ancestors; the install loops historically walked text tags
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

test('own #_autodep tag installs the immediate parent from the repo, fetched once', async () => {
  const { deps, fetches } = harness({ repo: { '#a/b': [] } })
  expect(await autodepParent(deps, '#a/b/c', ['#x', '#_autodep'])).toBe('#a/b')
  expect(fetches).toEqual(['#a/b']) // flag settled by own tags; only the parent lookup fetches
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

test('own #_autodep returns an installed immediate parent even with a false flag', async () => {
  // the item is autodep by its own tags; the parent joins the runtime graph as-is, no fetch
  const { deps, fetches } = harness({ local: { '#a': { autodep: false } } })
  expect(await autodepParent(deps, '#a/b', ['#_autodep'])).toBe('#a')
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
