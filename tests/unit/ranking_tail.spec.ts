import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import _ from 'lodash'

// the REAL ranking step of onEditorChange (index.svelte, extracted by its first and last lines): the dummy
// item pushed to mark where the "tail" starts (the items ranked by time alone), the sort, and the check
// that the items from the tail on are ordered by time. The dummy must carry every attribute the comparator
// reads: without `running` its comparison with a running item skipped that criterion (a number minus
// undefined is NaN), so the dummy ranked above a running item and below the items a running item ranks
// above, and its place depended on which items the sort happened to compare it with (the console line the
// owner reported on 2026-11-16 at the scroll shortcut, whose Back re-ranks the query)
const source = readFileSync(resolve(process.cwd(), 'src/routes/index.svelte'), 'utf8')
const step = source.match(
  /\n {6}items\.push\(\{\n {8}dotted: false,\n[\s\S]*?\n {8}console\.error\('items are not ordered by time above tail index', tailIndex\)\n/,
)?.[0]
if (!step) throw new Error('the ranking step (the dummy through the tail check) not found in index.svelte')
// the step's free variables, in the order `rank` supplies them
const FREE = ['items', 'now', 'text', 'context', 'listing', '_', 'console', 'lastRankedQuery', 'regroupTimeRowsPending']

const QUERY = '#t'
const NOW = 1_800_000_000_000
const HOUR = 3600 * 1000

// an item's ranking state, what the comparator and needs_prominence read, with the values the app holds
// (read off a lane's page under a query naming an item): here for an item the query does not concern
const item = (id: string, time: number, state: object = {}) => ({
  id,
  time,
  dotted: false,
  dotTerm: '',
  pinned: false,
  pinTerm: '',
  pinnedMatch: false,
  pinnedMatchTerm: '',
  log: false,
  uniqueLabel: '',
  target: false,
  target_context: false,
  editing: false,
  running: 0, // a count (the _Item setter adds one per holder)
  hasError: false,
  previewable: false,
  pushable: false,
  target_nesting: -Infinity,
  target_prefix_nesting: -Infinity,
  firstTagMatch: false,
  tagMatches: 0,
  labelMatch: false,
  prefixMatch: false,
  matchingTerms: [],
  matchingTermsSecondary: [],
  missingTags: [],
  ...state,
})
// the item the query names, an item marked running (onEditorChange sets its time to now before the step)
// and two items the query ranks by their depth under the named item, the deeper one the newer
const matching = { tagMatches: 1, prefixMatch: true, matchingTerms: [QUERY] }
const naming = { target: true, uniqueLabel: QUERY, target_nesting: 0, firstTagMatch: true, labelMatch: true }
const named = () => item('named', NOW + 2, { ...matching, ...naming })
const running = () => item('running', NOW, { running: 1 })
const child = () => item('child', NOW - 48 * HOUR, { ...matching, uniqueLabel: QUERY + '/a', target_nesting: -1 })
const grandchild = () =>
  item('grandchild', NOW - 24 * HOUR, { ...matching, uniqueLabel: QUERY + '/a/b', target_nesting: -2 })

// runs the step over `items` (ranked in place) and returns the index its tail starts at, what it logged,
// and the two things it made: the dummy (as pushed) and the comparator (as handed to sort)
function rank(items: any[]) {
  const made: { dummy?: any; compare?: (a: any, b: any) => number } = {}
  const errors: string[] = []
  const log = { error: (...args: unknown[]) => void errors.push(args.join(' ')) }
  items.push = (dummy: any) => Array.prototype.push.call(items, (made.dummy = dummy))
  items.sort = (compare: any) => Array.prototype.sort.call(items, (made.compare = compare))
  const run = new Function(...FREE, `${step}\nreturn tailIndex`)
  const tailIndex: number = run(items, NOW, QUERY, [QUERY], [QUERY], _, log, QUERY, false)
  return { tailIndex, errors, dummy: made.dummy, compare: made.compare! }
}

test('the dummy ranks below a running item, as an item ranked by time alone does', () => {
  const { dummy, compare } = rank([running()])
  expect(compare(running(), item('by time', NOW - HOUR)), 'above an item ranked by time').toBeLessThan(0)
  expect(compare(running(), dummy), 'and above the dummy').toBeLessThan(0)
  // the cycle the missing attribute made: the dummy above the running item, which ranks above the child,
  // which ranks above the dummy
  expect([compare(running(), child()), compare(child(), dummy)].map(Math.sign)).toEqual([-1, -1])
})

test('the tail starts after the items the query ranks while an item is running', () => {
  // a corpus in the order the query's last ranking left it, as at a re-ranking of the same query with nothing
  // relevant changed (the scroll shortcut's Back): fourteen pinned items, the named item, the running item at
  // index 15, the two ranked items, then the items ranked by time alone. As observed, V8 looked for the
  // dummy's place among 64 or more sorted items at the indices 1, 3, 7, 15, ...: at 15 it met the running
  // item and put the dummy above it, so the tail started at 16 with the two ranked items in it, the older
  // one first
  const pin = (i: number) => ({ pinned: true, pinTerm: `#_pin/${10 + i}` })
  const pinned = _.times(14, i => item(`pinned ${i}`, NOW - 1000 * HOUR, pin(i)))
  const byTime = _.times(46, i => item(`by time ${i}`, NOW - (i + 1) * HOUR))
  const items = [...pinned, named(), running(), child(), grandchild(), ...byTime]
  const order = items.map(item => item.id)
  const { tailIndex, errors } = rank(items)
  const ranked = items.map(item => item.id)
  expect(errors).toEqual([])
  expect(ranked, 'the order is the one the query ranked').toEqual(order)
  expect([tailIndex, items[tailIndex].id]).toEqual([18, 'by time 0'])
})
