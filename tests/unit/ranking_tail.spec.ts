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
  editingPromoted: false,
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
  matching: false,
  aboveFold: false,
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

type RankOptions = { text?: string; lastRankedQuery?: string | null; context?: string[]; listing?: string[] }

// runs the step over `items` (ranked in place) and returns the index its tail starts at, the next
// lastRankedQuery, what it logged, and the two things it made: the dummy (as pushed) and the comparator
function rank(
  items: any[],
  {
    text = QUERY,
    lastRankedQuery = text,
    context = text == '#log' ? [] : [text],
    listing = text == '#log' ? [] : [text],
  }: RankOptions = {},
) {
  const made: { dummy?: any; compare?: (a: any, b: any) => number } = {}
  const errors: string[] = []
  const log = { error: (...args: unknown[]) => void errors.push(args.join(' ')) }
  items.push = (dummy: any) => Array.prototype.push.call(items, (made.dummy = dummy))
  items.sort = (compare: any) => Array.prototype.sort.call(items, (made.compare = compare))
  const run = new Function(...FREE, `${step}\nreturn { tailIndex, lastRankedQuery }`)
  const { tailIndex, lastRankedQuery: nextRankedQuery } = run(
    items,
    NOW,
    text,
    context,
    listing,
    _,
    log,
    lastRankedQuery,
    false,
  )
  return { tailIndex, lastRankedQuery: nextRankedQuery as string, errors, dummy: made.dummy, compare: made.compare! }
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

test('an edited log item stays in place while the ranked query is unchanged', () => {
  const MID_TIME = NOW - 10 * HOUR
  // under #log: by time among the log items, below an edited non-log item
  const editedNonLog = item('edited-non-log', NOW, { editing: true })
  const newLog = item('new-log', NOW - HOUR, { log: true })
  const editedLog = item('edited-log', MID_TIME, { log: true, editing: true })
  const oldLog = item('old-log', NOW - 20 * HOUR, { log: true })
  const atLogItems = [oldLog, editedLog, newLog, editedNonLog]
  const atLog = rank(atLogItems, { text: '#log', lastRankedQuery: '#log' })
  expect(atLog.errors).toEqual([])
  expect(atLogItems.map(i => i.id)).toEqual(['edited-non-log', 'new-log', 'edited-log', 'old-log'])
  expect([editedLog.editingPromoted, editedLog.time]).toEqual([false, MID_TIME])

  // under another query: by time where it would rank without the edit
  const editedOther = item('edited-log', MID_TIME, { log: true, editing: true })
  const plainOther = item('edited-log', MID_TIME, { log: true, editing: false })
  const corpus = (logItem: any) => [
    item('older-by-time', NOW - 20 * HOUR),
    logItem,
    item('newer-by-time', NOW - 5 * HOUR),
    child(),
    item('edited-non-log', NOW, { editing: true }),
    named(),
  ]
  const withEdit = corpus(editedOther)
  const withoutEdit = corpus(plainOther)
  const atOther = rank(withEdit, { text: QUERY, lastRankedQuery: QUERY })
  rank(withoutEdit, { text: QUERY, lastRankedQuery: QUERY })
  expect(atOther.errors).toEqual([])
  expect(withEdit.map(i => i.id)).toEqual(['named', 'edited-non-log', 'child', 'newer-by-time', 'edited-log', 'older-by-time'])
  expect(withEdit.map(i => i.id)).toEqual(withoutEdit.map(i => i.id))
  expect([editedOther.editingPromoted, editedOther.time]).toEqual([false, MID_TIME])
})

test('an edited log item moves up with the edited items once the ranked query changes', () => {
  const OLD_TIME = NOW - 100 * HOUR
  const pinnedMatch = item('pinned-match', OLD_TIME - HOUR, { pinnedMatch: true, pinnedMatchTerm: '#_log/pin' })
  const editedNonLog = item('edited-non-log', NOW, { editing: true })
  const editedLog = item('edited-log', OLD_TIME, { log: true, editing: true })
  const newLog = item('new-log', NOW - HOUR, { log: true })
  const oldLog = item('old-log', NOW - 20 * HOUR, { log: true })
  const errItem = item('err', NOW - 2 * HOUR, { hasError: true })

  // query changes to #log: editedLog leaves its place and ranks with the edited items above the log list
  const atLogItems = [oldLog, editedLog, newLog, errItem, editedNonLog, pinnedMatch]
  const atLog = rank(atLogItems, { text: '#log', lastRankedQuery: 'old query' })
  expect(atLog.errors).toEqual([])
  expect(atLogItems.map(i => i.id)).toEqual(['pinned-match', 'edited-log', 'edited-non-log', 'new-log', 'old-log', 'err'])
  expect(atLog.dummy.editingPromoted, 'dummy defines editingPromoted').toBe(false)
  expect(atLog.compare(editedLog, atLog.dummy), 'promoted edited log ranks above dummy').toBeLessThan(0)
  expect([editedLog.editingPromoted, editedLog.time, newLog.editingPromoted, editedNonLog.editingPromoted]).toEqual([
    true,
    OLD_TIME,
    false,
    false,
  ])

  // query changes to another query with a target: stays with edited items, below target and above running/matches/logs
  const atOtherItems = [oldLog, child(), running(), editedLog, editedNonLog, named()]
  const atOther = rank(atOtherItems, { text: QUERY, lastRankedQuery: atLog.lastRankedQuery })
  expect(atOther.errors).toEqual([])
  expect(atOther.compare(editedLog, atOther.dummy), 'promoted edited log ranks above dummy under another query').toBeLessThan(0)
  expect([editedLog.editingPromoted, editedLog.time]).toEqual([true, OLD_TIME])
  expect(atOtherItems.map(i => i.id)).toEqual(['named', 'edited-non-log', 'edited-log', 'running', 'child', 'old-log'])

  // returning to the original query (and re-ranking it): stays promoted until the edit ends
  const backItems = [newLog, running(), editedLog]
  const atBack = rank(backItems, { text: 'old query', lastRankedQuery: atOther.lastRankedQuery, context: [], listing: [] })
  expect(atBack.errors).toEqual([])
  expect(backItems.map(i => i.id)).toEqual(['edited-log', 'running', 'new-log'])
  const sameBack = [newLog, running(), editedLog]
  rank(sameBack, { text: 'old query', lastRankedQuery: atBack.lastRankedQuery, context: [], listing: [] })
  expect(sameBack.map(i => i.id)).toEqual(['edited-log', 'running', 'new-log'])
  expect([editedLog.editingPromoted, editedLog.time]).toEqual([true, OLD_TIME])

  // once the edit ends, back at its place by time under #log and never promoted while not editing
  editedLog.editing = false
  editedLog.editingPromoted = false
  const afterEnd = [editedLog, oldLog, newLog]
  const atEnd = rank(afterEnd, { text: '#log', lastRankedQuery: atBack.lastRankedQuery })
  expect(atEnd.errors).toEqual([])
  expect(afterEnd.map(i => i.id)).toEqual(['new-log', 'old-log', 'edited-log'])
  expect([editedLog.editingPromoted, editedLog.time]).toEqual([false, OLD_TIME])
})

// the REAL hideIndexMinimal floor in onEditorChange (index.svelte), anchored on code statements alone
const floorStep = source.match(
  /\n {6}hideIndexMinimal = toggles\.length == 0[\s\S]*?\n {6}if \(hideIndex < hideIndexMinimal\) hideIndex = hideIndexMinimal\n/,
)?.[0]
if (!floorStep) throw new Error('the hideIndexMinimal floor step not found in index.svelte')

function runFloor({
  items,
  toggles = [],
  target = null,
  hideIndex = 0,
  hideIndexFromRanking = toggles.at(-1)?.end ?? items.length,
  editorText = QUERY,
  keep_times = false,
  typedInput = false,
  restoredHideIndex = 0,
  editorTextModified = false,
}: {
  items: any[]
  toggles?: Array<{ start: number; end: number }>
  target?: any
  hideIndex?: number
  hideIndexFromRanking?: number
  editorText?: string
  keep_times?: boolean
  typedInput?: boolean
  restoredHideIndex?: number
  editorTextModified?: boolean
}) {
  const editingItems = items.flatMap((it, i) => (it.editing ? [i] : []))
  const run = new Function(
    'items',
    'toggles',
    'editingItems',
    'hideIndexFromRanking',
    'target',
    'hideIndex',
    '_',
    'editorText',
    'keep_times',
    'typedInput',
    'restoredHideIndex',
    'editorTextModified',
    `let hideIndexMinimal = 0
let lastEditorChangeTime = Infinity
let editorChangeInput = null
let restartTextModified = false
const onEditorChange = (text, keep) => ({ restarted: true, hideIndexMinimal, hideIndex, lastEditorChangeTime, editorChangeInput, restartTextModified, text, keep_times: keep })
${floorStep}
return { restarted: false, hideIndexMinimal, hideIndex, lastEditorChangeTime, editorChangeInput, restartTextModified }`,
  )
  return run(
    items,
    toggles.map(t => ({ ...t })),
    editingItems,
    hideIndexFromRanking,
    target,
    hideIndex,
    _,
    editorText,
    keep_times,
    typedInput,
    restoredHideIndex,
    editorTextModified,
  ) as {
    restarted: boolean
    hideIndexMinimal: number
    hideIndex: number
    lastEditorChangeTime: number
    editorChangeInput: string | null
    restartTextModified: boolean
    text?: string
    keep_times?: boolean
  }
}

test('the cutoff floor stops on the end of the last counting editor step', () => {
  const mk = (i: number, state: object = {}) => item(`i_${i}`, NOW - i * HOUR, state)
  const steps = [
    { start: 5, end: 15 },
    { start: 15, end: 35 },
    { start: 35, end: 52 },
  ]

  // two editors at once, with a promoted log deeper than a non-log editor: must advance to the deeper step end (52, not 35)
  const twoEditors = _.times(52, i =>
    mk(i, i == 17 ? { editing: true } : i == 40 ? { log: true, editing: true, editingPromoted: true } : {}),
  )
  expect(runFloor({ items: twoEditors, toggles: steps, target: twoEditors[6] })).toMatchObject({
    restarted: false,
    hideIndexMinimal: 52,
    hideIndex: 52,
  })

  // in-place log whose step starts at or below the prior cutoff counts in place (never promoted)
  const inPlace = _.times(52, i => mk(i, i == 36 ? { log: true, editing: true } : { log: true }))
  expect(runFloor({ items: inPlace, toggles: steps, hideIndex: 52 })).toMatchObject({
    restarted: false,
    hideIndexMinimal: 52,
    hideIndex: 52,
  })
  expect(runFloor({ items: inPlace, toggles: steps, hideIndex: 35 })).toMatchObject({
    restarted: false,
    hideIndexMinimal: 52,
    hideIndex: 52,
  })
  expect(inPlace[36].editingPromoted, 'near in-place log stays unpromoted').toBe(false)

  // in-place log whose step starts beyond the prior cutoff is promoted and restarts onEditorChange
  // (restoring debounce bypass and typedInput origin)
  const farRes = runFloor({
    items: inPlace,
    toggles: steps,
    hideIndex: 15,
    editorText: '#topic ',
    keep_times: true,
    typedInput: true,
  })
  expect(farRes, 'far in-place log restarts with debounce cleared and typedInput restored').toMatchObject({
    restarted: true,
    lastEditorChangeTime: 0,
    editorChangeInput: '#topic ',
    text: '#topic ',
    keep_times: true,
  })
  expect(inPlace[36].editingPromoted, 'far in-place log is promoted').toBe(true)

  // mixed editors: far unpromoted log is promoted and restarts while earlier non-log editor stays unaffected
  const mixed = _.times(52, i => mk(i, i == 17 ? { editing: true } : i == 40 ? { log: true, editing: true } : {}))
  const mixedRes = runFloor({ items: mixed, toggles: steps, hideIndex: 15 })
  expect(mixedRes.restarted, 'far log editor among mixed editors restarts').toBe(true)
  expect(mixed[40].editingPromoted, 'far unpromoted log is promoted').toBe(true)
  expect(mixed[17].editingPromoted, 'non-log editor does not get editingPromoted').toBe(false)

  // no-toggle branch and no-editor baseline stay untouched
  const plain = _.times(5, i => mk(i))
  expect(runFloor({ items: plain, toggles: [{ start: 1, end: 5 }], target: plain[2] })).toMatchObject({
    restarted: false,
    hideIndexMinimal: 1,
    hideIndex: 1,
  })
  const noToggle = [mk(0, { pinned: true }), mk(1, { editing: true }), mk(2)]
  expect(runFloor({ items: noToggle, toggles: [], hideIndexFromRanking: 2 })).toMatchObject({
    restarted: false,
    hideIndexMinimal: 2,
    hideIndex: 2,
  })
})

// the REAL needs_prominence + position-based toggle, cutoff, and reset-to-ideal step in onEditorChange (index.svelte)
const needsProminenceStep = source.match(
  /\n {6}const needs_prominence = item =>\n[\s\S]*?\n {8}item\.previewable\n/,
)?.[0]
if (!needsProminenceStep) throw new Error('needs_prominence not found in index.svelte')
const toggleCutoffStep = source.match(
  /\n {6}toggles = \[\]\n[\s\S]*?\n {6}if \(hideIndex < hideIndexMinimal\) hideIndex = hideIndexMinimal\n/,
)?.[0]
if (!toggleCutoffStep) throw new Error('the toggle and cutoff step not found in index.svelte')
const toggleResetStep = source.match(
  /\n {6}toggles = \[\]\n[\s\S]*?\n {6}itemIdsOnLastEditorChange = itemIds\n/,
)?.[0]
if (!toggleResetStep) throw new Error('the toggle and cutoff reset step not found in index.svelte')

function runToggles({
  items,
  target = items.find(i => i.target) ?? null,
  hideIndex = 0,
  hideIndexFromRanking = items.length,
  restoredHideIndex = 0,
}: {
  items: any[]
  target?: any
  hideIndex?: number
  hideIndexFromRanking?: number
  restoredHideIndex?: number
}) {
  const editingItems = items.flatMap((it, i) => (it.editing ? [i] : []))
  const run = new Function(
    'items',
    'editingItems',
    'hideIndexFromRanking',
    'target',
    'hideIndex',
    '_',
    'restoredHideIndex',
    `let toggles = []
let hideIndexMinimal = 0
let lastEditorChangeTime = Infinity
let editorChangeInput = null
let restartTextModified = false
const editorText = ''
const keep_times = false
const typedInput = false
const editorTextModified = false
const onEditorChange = () => ({ toggles, unpinnedIndex, nonmatchingIndex, belowFoldIndex, hideIndexMinimal, hideIndex, restarted: true })
${needsProminenceStep}
${toggleCutoffStep}
return { toggles, unpinnedIndex, nonmatchingIndex, belowFoldIndex, hideIndexMinimal, hideIndex, restarted: false }`,
  )
  return run(items, editingItems, hideIndexFromRanking, target, hideIndex, _, restoredHideIndex) as {
    toggles: Array<{ start: number; end: number; positionBased?: boolean; type?: string }>
    unpinnedIndex: number
    nonmatchingIndex: number
    belowFoldIndex: number
    hideIndexMinimal: number
    hideIndex: number
    restarted: boolean
  }
}

// runs the real sort + real toggle/cutoff/reset step across rankings; when the step promotes an
// unpromoted in-place log and calls onEditorChange, the stub runs the second pass over the same
// prior hideIndex and itemIdsOnLastEditorChange
function runRanking({
  items,
  text,
  lastRankedQuery = text,
  context = text == '#log' ? [] : [text],
  listing = text == '#log' ? [] : [text],
  hideIndex = 0,
  itemIdsOnLastEditorChange = [] as string[],
  editorTextModified = false,
  typedInput = false,
  keep_times = false,
  sessionTime = NOW + 1,
  restoredHideIndex = 0,
}: {
  items: any[]
  text: string
  lastRankedQuery?: string | null
  context?: string[]
  listing?: string[]
  hideIndex?: number
  itemIdsOnLastEditorChange?: string[]
  editorTextModified?: boolean
  typedInput?: boolean
  keep_times?: boolean
  sessionTime?: number
  restoredHideIndex?: number
}) {
  let passes = 0
  let restartResetTime: number | null = null
  let restartInput: string | null = null
  let restartModified: boolean | null = null
  const exec = (
    curText: string,
    curKeepTimes: boolean,
    curLastRankedQuery: string | null,
    curTypedInput: boolean,
    curEditorTextModified: boolean,
  ): {
    toggles: Array<{ start: number; end: number; positionBased?: boolean; type?: string }>
    hideIndexMinimal: number
    hideIndex: number
    itemIdsOnLastEditorChange: string[]
    lastRankedQuery: string
    errors: string[]
    passes: number
    restartResetTime: number | null
    restartInput: string | null
    restartModified: boolean | null
  } => {
    passes++
    if (passes > 5) throw new Error('runRanking exceeded maximum passes')
    const r = rank(items, { text: curText, lastRankedQuery: curLastRankedQuery, context, listing })
    const editingItems = items.flatMap((it, i) => (it.editing ? [i] : []))
    const target = items.find(i => i.target) ?? null
    const run = new Function(
      'items',
      'editingItems',
      'hideIndexFromRanking',
      'target',
      'hideIndex',
      '_',
      'sessionTime',
      'itemIdsOnLastEditorChange',
      'editorTextModified',
      'editorText',
      'keep_times',
      'typedInput',
      'restoredHideIndex',
      'restart',
      `let toggles = []
let hideIndexMinimal = 0
let hideIndexForSession = 0
let lastEditorChangeTime = Infinity
let editorChangeInput = null
let restartTextModified = false
const onEditorChange = (nextText, nextKeep) => restart(nextText, nextKeep, lastEditorChangeTime, editorChangeInput, restartTextModified)
${needsProminenceStep}
${toggleResetStep}
return { toggles, hideIndexMinimal, hideIndex, itemIdsOnLastEditorChange }`,
    )
    const res = run(
      items,
      editingItems,
      r.tailIndex,
      target,
      hideIndex,
      _,
      sessionTime,
      itemIdsOnLastEditorChange,
      curEditorTextModified,
      curText,
      curKeepTimes,
      curTypedInput,
      restoredHideIndex,
      (nextText: string, nextKeep: boolean, resetTime: number, savedInput: string | null, carriedModified: boolean) => {
        restartResetTime = resetTime
        restartInput = savedInput
        restartModified = carriedModified
        return exec(
          nextText,
          nextKeep,
          r.lastRankedQuery,
          savedInput !== null && savedInput === nextText,
          carriedModified,
        )
      },
    )
    return {
      ...res,
      lastRankedQuery: res.lastRankedQuery ?? r.lastRankedQuery,
      errors: [...r.errors, ...(res.errors ?? [])],
      passes,
      restartResetTime,
      restartInput,
      restartModified,
    }
  }
  return exec(text, keep_times, lastRankedQuery, typedInput, editorTextModified)
}

test('target queries trim leading toggle steps past the last target without moving later boundaries or targetless queries', () => {
  const mk = (i: number, state: object = {}) =>
    item(`i_${i}`, NOW - i * HOUR, { matching: true, aboveFold: false, ...state })

  // target behind 5 global pins and 12 search-specific pins, followed by 63 ranked items:
  // leading step [5, 15) is dropped, [15, 35) is trimmed to [18, 35), and every later boundary stays identical
  const pinnedTopic = [
    ..._.times(5, i => mk(i, { pinned: true, aboveFold: true })),
    ..._.times(12, i => mk(5 + i, { pinnedMatch: true, pinnedMatchTerm: `#_topic/pin/${i}` })),
    mk(17, { target: true, uniqueLabel: '#topic' }),
    ..._.times(63, i => mk(18 + i)),
  ]
  const untrimmed = runToggles({ items: pinnedTopic, target: null }).toggles
  const trimmed = runToggles({ items: pinnedTopic })
  expect(untrimmed.map(t => [t.start, t.end]), 'untrimmed baseline steps').toEqual([
    [5, 15],
    [15, 35],
    [35, 55],
    [55, 81],
  ])
  expect(trimmed.toggles[0]?.start, 'first step starts just past the target').toBe(18)
  expect(
    trimmed.toggles.map(t => t.end),
    'every surviving step end equals the untrimmed baseline',
  ).toEqual(untrimmed.filter(t => t.end > 18).map(t => t.end))
  expect(trimmed.toggles.slice(1), 'every later step keeps its exact untrimmed boundaries').toEqual(
    untrimmed.filter(t => t.start >= 18),
  )
  expect(trimmed.hideIndexMinimal, 'cutoff hides neither pins nor target').toBe(18)

  // multiple target items (e.g. id: matches): trims past the LAST target item
  const multiTarget = [
    mk(0, { pinned: true, aboveFold: true }),
    mk(1, { pinnedMatch: true, pinnedMatchTerm: '#_t/pin' }),
    mk(2, { target: true }),
    mk(3, { target: true }),
    mk(4),
  ]
  const atMulti = runToggles({ items: multiTarget })
  expect(atMulti.toggles.map(t => [t.start, t.end]), 'trims past the last target').toEqual([[4, 5]])
  expect(atMulti.hideIndexMinimal).toBe(4)

  // no non-prominent items after the target: all position-based steps are trimmed away
  const targetOnly = [
    ..._.times(5, i => mk(i, { pinned: true, aboveFold: true })),
    mk(5, { pinnedMatch: true, pinnedMatchTerm: '#_topic/pin' }),
    mk(6, { target: true }),
  ]
  const atTargetOnly = runToggles({ items: targetOnly })
  expect(atTargetOnly.toggles, 'all position-based steps dropped past the target').toEqual([])
  expect(atTargetOnly.hideIndexMinimal, 'cutoff falls back to hideIndexFromRanking past target').toBe(7)

  // targetless prefix query with 500 pinnedMatch items (e.g. typing #a): untouched, cutoff stays 10
  const prefixPins = _.times(500, i =>
    mk(i, { pinnedMatch: true, pinnedMatchTerm: `#_alpha_${i}/pin`, aboveFold: false }),
  )
  const atPrefix = runToggles({ items: prefixPins })
  expect(atPrefix.toggles[0], 'targetless prefix query keeps the first below-fold step at 0..10').toMatchObject({
    start: 0,
    end: 10,
  })
  expect(atPrefix.hideIndexMinimal, 'targetless prefix query cutoff stays 10, not 500').toBe(10)
})

test('a retagged log edited in place under a pinned target stays visible when saved (review 5 regression)', () => {
  // 5 global pins, 12 #_topic/pin items, unique #topic target, 31 #log #topic items, 32 #log #topic/sub items
  const topicMatching = { matching: true, matchingTerms: ['#topic'], aboveFold: false }
  const globalPins = _.times(5, i =>
    item(`pin_${i}`, NOW - 1000 * HOUR, { pinned: true, pinTerm: `#_pin/${i}`, aboveFold: true }),
  )
  const searchPins = _.times(12, i =>
    item(`spin_${String(i).padStart(2, '0')}`, NOW - 900 * HOUR, {
      pinnedMatch: true,
      pinnedMatchTerm: `#_topic/pin/${String(i).padStart(2, '0')}`,
      ...topicMatching,
    }),
  )
  const targetItem = item('topic', NOW + 2, {
    target: true,
    uniqueLabel: '#topic',
    target_nesting: 0,
    firstTagMatch: true,
    tagMatches: 1,
    labelMatch: true,
    prefixMatch: true,
    ...topicMatching,
  })
  const exactLogs = _.times(31, i =>
    item(`exact_${i}`, NOW - (i + 1) * HOUR, {
      log: true,
      firstTagMatch: true,
      tagMatches: 1,
      ...topicMatching,
    }),
  )
  const subLogs = _.times(32, i =>
    item(`sub_${i}`, NOW - (100 + i) * HOUR, {
      log: true,
      firstTagMatch: false,
      tagMatches: 1, // visible #topic/sub expands to #topic in tagsVisibleExpanded
      ...topicMatching,
    }),
  )
  const all = [...globalPins, ...searchPins, targetItem, ...exactLogs, ...subLogs]

  // 1. Search #topic: initial cutoff is 18 (pins + target visible)
  const r1 = rank(all, { text: '#topic', lastRankedQuery: '' })
  expect(r1.errors).toEqual([])
  const t1 = runToggles({ items: all, hideIndexFromRanking: r1.tailIndex })
  expect(t1.hideIndexMinimal, 'initial search shows pins and target').toBe(18)

  // 2. Click Show more twice (past index 25), open log at index 25 (exact_7) in edit mode, append a space (#topic )
  const expanded = t1.toggles[1].end
  expect(expanded, 'precondition: two Show more clicks reveal index 25').toBeGreaterThan(25)
  const edited = all[25]
  expect(edited.id).toBe('exact_7')
  edited.editing = true
  const r2 = rank(all, { text: '#topic ', lastRankedQuery: r1.lastRankedQuery })
  expect(r2.errors).toEqual([])
  expect(edited.editingPromoted, 'trailing space keeps log edited in place').toBe(false)
  const t2 = runToggles({ items: all, hideIndex: expanded, hideIndexFromRanking: r2.tailIndex })
  // editorTextModified resets hideIndex to hideIndexIdeal (= hideIndexMinimal here)
  const afterSpaceHideIndex = t2.hideIndexMinimal

  // 3. Retag edited log from #topic to #topic/sub and save without closing: only firstTagMatch flips
  // (tagMatches stays 1 because #topic/sub expands to #topic); moves to index 48 in [35, 55),
  // whose start (35) <= prior cutoff (35), raising cutoff to 55 so the editor stays in view
  edited.firstTagMatch = false
  const r3 = rank(all, { text: '#topic ', lastRankedQuery: r2.lastRankedQuery })
  expect(r3.errors).toEqual([])
  const movedIdx = all.findIndex(i => i.id == edited.id)
  expect(movedIdx, 'retagged log moves behind exact matches to index 48').toBe(48)
  const t3 = runToggles({ items: all, hideIndex: afterSpaceHideIndex, hideIndexFromRanking: r3.tailIndex })
  const holdingStep = t3.toggles.find(t => movedIdx >= t.start && movedIdx < t.end)
  expect(
    holdingStep!.start,
    `step holding moved editor (${holdingStep!.start}..${holdingStep!.end}) starts at or below prior cutoff (${afterSpaceHideIndex})`,
  ).toBeLessThanOrEqual(afterSpaceHideIndex)
  expect(
    movedIdx,
    `retagged log editor (${movedIdx}) stays visible below cutoff (${t3.hideIndexMinimal})`,
  ).toBeLessThan(t3.hideIndexMinimal)
  expect(t3.hideIndexMinimal, 'post-save cutoff matches master (55)').toBe(55)
})

test('trimming after the editor loop keeps an in-place log draft visible when a target or context arrives (review 6)', () => {
  // Case 1: 3 notes in one column above the fold (#a, #p #_a/topic/pin, #log #a/topic entry).
  // Under #a/topic with the log edited in place at index 1 (2 rows shown), another tab creates unique #a/topic:
  // order becomes [pin, #a (context), #a/topic (target), log (index 3)]. Original step [0, 4) starts at 0 <= 2,
  // so all 4 rows stay visible; trimming before the editor loop shrank the step to [3, 4) (3 > 2) and hid the draft.
  const matchATopic = { matching: true, matchingTerms: ['#a/topic'], aboveFold: true }
  const aBefore = item('a', NOW - 3 * HOUR, { uniqueLabel: '#a', matching: false, aboveFold: true })
  const pinBefore = item('pin', NOW - 2 * HOUR, {
    pinnedMatch: true,
    pinnedMatchTerm: '#_a/topic/pin',
    ...matchATopic,
  })
  const logBefore = item('log', NOW - HOUR, {
    log: true,
    editing: true,
    firstTagMatch: true,
    tagMatches: 1,
    ...matchATopic,
  })
  const beforeArrival = [aBefore, pinBefore, logBefore]
  const rBefore = rank(beforeArrival, { text: '#a/topic', lastRankedQuery: '#a/topic', context: [], listing: [] })
  expect(rBefore.errors).toEqual([])
  expect(beforeArrival.map(i => i.id)).toEqual(['pin', 'log', 'a'])
  expect(logBefore.editingPromoted, 'log is edited in place').toBe(false)
  const tBefore = runToggles({ items: beforeArrival, hideIndexFromRanking: rBefore.tailIndex })
  expect(tBefore.hideIndexMinimal, 'before arrival: 2 rows shown with log at index 1').toBe(2)

  // Unique #a/topic note arrives from another tab (same query, prior hideIndex = 2)
  const topicNew = item('topic', NOW + 2, {
    target: true,
    uniqueLabel: '#a/topic',
    target_nesting: 0,
    firstTagMatch: true,
    tagMatches: 1,
    labelMatch: true,
    prefixMatch: true,
    ...matchATopic,
  })
  const afterArrival = [pinBefore, { ...aBefore, target_context: true }, topicNew, logBefore]
  const rAfter = rank(afterArrival, {
    text: '#a/topic',
    lastRankedQuery: rBefore.lastRankedQuery,
    context: ['#a/topic', '#a'],
    listing: ['#a/topic'],
  })
  expect(rAfter.errors).toEqual([])
  expect(afterArrival.map(i => i.id)).toEqual(['pin', 'a', 'topic', 'log'])
  expect(logBefore.editingPromoted, 'log stays unpromoted under unchanged query').toBe(false)
  const tAfter = runToggles({
    items: afterArrival,
    hideIndex: tBefore.hideIndexMinimal,
    hideIndexFromRanking: rAfter.tailIndex,
  })
  expect(tAfter.toggles.map(t => [t.start, t.end]), 'trimmed toggle starts past target').toEqual([[3, 4]])
  expect(tAfter.hideIndexMinimal, 'after arrival: in-place log at index 3 stays visible (minimum 4)').toBe(4)
  expect(3).toBeLessThan(tAfter.hideIndex)

  // Case 2: target present throughout; one remote edit turns #area/project into #_context for #topic,
  // moving both #area and #area/project above #topic and shifting the open log from 2 to 4 (prior cutoff 3)
  const matchTopic = { matching: true, matchingTerms: ['#topic'], aboveFold: true }
  const ctxPin = item('pin', NOW - 5 * HOUR, {
    pinnedMatch: true,
    pinnedMatchTerm: '#_topic/pin',
    ...matchTopic,
  })
  const ctxTarget = item('topic', NOW + 2, {
    target: true,
    uniqueLabel: '#topic',
    target_nesting: 0,
    firstTagMatch: true,
    tagMatches: 1,
    labelMatch: true,
    prefixMatch: true,
    ...matchTopic,
  })
  const ctxLog = item('log', NOW - 4 * HOUR, {
    log: true,
    editing: true,
    firstTagMatch: true,
    tagMatches: 1,
    ...matchTopic,
  })
  const area = item('area', NOW - 3 * HOUR, { uniqueLabel: '#area', target_context: true, matching: false, aboveFold: true })
  const proj = item('proj', NOW - 2 * HOUR, {
    uniqueLabel: '#area/project',
    target_context: true,
    ...matchTopic,
  })
  const afterCtx = [ctxPin, ctxTarget, ctxLog, area, proj]
  const rCtx = rank(afterCtx, {
    text: '#topic',
    lastRankedQuery: '#topic',
    context: ['#topic', '#area/project', '#area'],
    listing: ['#topic'],
  })
  expect(rCtx.errors).toEqual([])
  expect(afterCtx.map(i => i.id)).toEqual(['pin', 'area', 'proj', 'topic', 'log'])
  const tCtx = runToggles({ items: afterCtx, hideIndex: 3, hideIndexFromRanking: rCtx.tailIndex })
  expect(tCtx.toggles.map(t => [t.start, t.end])).toEqual([[4, 5]])
  expect(tCtx.hideIndexMinimal, 'after remote #_context edit: in-place log at index 4 stays visible (minimum 5)').toBe(5)
  expect(4).toBeLessThan(tCtx.hideIndex)

  // Editor among search pins in a step dropped by the trim: hideIndexMinimal is raised to the first surviving step start
  const mk = (i: number, state: object = {}) =>
    item(`p_${i}`, NOW - i * HOUR, { matching: true, aboveFold: false, ...state })
  const pinEdited = [
    ..._.times(5, i => mk(i, { pinned: true, aboveFold: true })),
    ..._.times(12, i => mk(5 + i, { pinnedMatch: true, pinnedMatchTerm: `#_topic/pin/${i}`, editing: i == 2 })),
    mk(17, { target: true, uniqueLabel: '#topic' }),
    ..._.times(20, i => mk(18 + i)),
  ]
  const tPinEdit = runToggles({ items: pinEdited })
  expect(tPinEdit.toggles[0]?.start, 'first surviving step starts past target').toBe(18)
  expect(tPinEdit.hideIndexMinimal, 'dropped editor step raises minimum to first surviving step start').toBe(18)
})

test('a far-moving in-place log editor is promoted and re-ranked in view across sync and save (review 7)', () => {
  // Review 7 table: #topic with 5 global pins, 12 #_topic/pin items, target, 42 exact #log #topic, 20 #log #topic/sub
  const topicMatching = { matching: true, matchingTerms: ['#topic'], aboveFold: false }
  const globalPins = _.times(5, i =>
    item(`pin_${i}`, NOW - 1000 * HOUR, { pinned: true, pinTerm: `#_pin/${i}`, aboveFold: true }),
  )
  const searchPins = _.times(12, i =>
    item(`spin_${String(i).padStart(2, '0')}`, NOW - 900 * HOUR, {
      pinnedMatch: true,
      pinnedMatchTerm: `#_topic/pin/${String(i).padStart(2, '0')}`,
      ...topicMatching,
    }),
  )
  const targetItem = item('topic', NOW + 2, {
    target: true,
    uniqueLabel: '#topic',
    target_nesting: 0,
    firstTagMatch: true,
    tagMatches: 1,
    labelMatch: true,
    prefixMatch: true,
    ...topicMatching,
  })
  const exactLogs = _.times(42, i =>
    item(`exact_${i}`, NOW - (i + 2) * HOUR, {
      log: true,
      firstTagMatch: true,
      tagMatches: 1,
      ...topicMatching,
    }),
  )
  const subLogs = _.times(20, i =>
    item(`sub_${i}`, NOW - (200 + i) * HOUR, {
      log: true,
      firstTagMatch: false,
      tagMatches: 1,
      ...topicMatching,
    }),
  )
  const all = [...globalPins, ...searchPins, targetItem, ...exactLogs, ...subLogs]

  // 1. Initial search #topic: 18 rows shown (pins + target)
  const s1 = runRanking({ items: all, text: '#topic', lastRankedQuery: '', editorTextModified: true })
  expect(s1.errors).toEqual([])
  expect(s1.passes).toBe(1)
  expect(s1.hideIndex, 'initial search shows 18 rows').toBe(18)

  // 2. Three Show more clicks (18 -> 35 -> 55 -> 80), then open exact-tag log at index 24
  expect(s1.toggles.map(t => [t.start, t.end])).toEqual([
    [18, 35],
    [35, 55],
    [55, 80],
  ])
  const afterThreeClicks = s1.toggles[2].end
  expect(afterThreeClicks).toBe(80)
  const edited = all[24]
  expect(edited.id).toBe('exact_6')
  edited.editing = true
  const s2 = runRanking({
    items: all,
    text: '#topic',
    lastRankedQuery: s1.lastRankedQuery,
    hideIndex: afterThreeClicks,
    itemIdsOnLastEditorChange: s1.itemIdsOnLastEditorChange,
  })
  expect(s2.errors).toEqual([])
  expect(s2.passes).toBe(1)
  expect(s2.hideIndex, 'opening the log keeps all 80 expanded rows').toBe(80)
  expect(edited.editingPromoted, 'log stays edited in place when opened').toBe(false)

  // 3. Another tab creates one new #log #topic/sub note: arrives at index 60 (< 80), resetting cutoff to 35
  const arrivedSub = item('sub_arrived', NOW - HOUR, {
    log: true,
    firstTagMatch: false,
    tagMatches: 1,
    ...topicMatching,
  })
  all.push(arrivedSub)
  const s3 = runRanking({
    items: all,
    text: '#topic',
    lastRankedQuery: s2.lastRankedQuery,
    hideIndex: s2.hideIndex,
    itemIdsOnLastEditorChange: s2.itemIdsOnLastEditorChange,
  })
  expect(s3.errors).toEqual([])
  expect(s3.passes).toBe(1)
  expect(all.findIndex(i => i.id == arrivedSub.id), 'arrived subtag log lands at index 60').toBe(60)
  expect(all.findIndex(i => i.id == edited.id), 'open log remains at index 24').toBe(24)
  expect(s3.hideIndex, 'arrival resets expanded list to the editor floor (35)').toBe(35)
  expect(edited.editingPromoted, 'arrival keeps in-place log unpromoted').toBe(false)

  // 4. Retag open log to #topic/sub and save without closing: would land at 60 in [55, 81) (55 > 35),
  // so the floor promotes it and restarts onEditorChange, placing it directly below target (index 18) and in view
  edited.firstTagMatch = false
  const s4 = runRanking({
    items: all,
    text: '#topic',
    lastRankedQuery: s3.lastRankedQuery,
    hideIndex: s3.hideIndex,
    itemIdsOnLastEditorChange: s3.itemIdsOnLastEditorChange,
  })
  expect(s4.errors).toEqual([])
  const targetIdx = all.findIndex(i => i.id == targetItem.id)
  const editedIdx = all.findIndex(i => i.id == edited.id)
  expect(
    { promoted: edited.editingPromoted, editedIdx, hideIndex: s4.hideIndex, passes: s4.passes },
    'far-moving log editor is promoted directly below target and kept visible',
  ).toEqual({ promoted: true, editedIdx: targetIdx + 1, hideIndex: 35, passes: 2 })
  expect(s4.restartResetTime, 'restart clears debounce before second pass').toBe(0)
  expect(editedIdx, `promoted editor (${editedIdx}) stays below cutoff (${s4.hideIndex})`).toBeLessThan(s4.hideIndex)
})

test('an in-place log saved so it no longer matches or loses search on a leading slash is promoted, while a near move stays in place', () => {
  // 1. In-place log saved so it no longer matches (lands in non-matching tail past cutoff): promoted and in view
  const topicMatching = { matching: true, matchingTerms: ['#topic'], aboveFold: false }
  const pins = _.times(5, i => item(`p_${i}`, NOW - 1000 * HOUR, { pinned: true, aboveFold: true }))
  const target = item('topic', NOW + 2, {
    target: true,
    uniqueLabel: '#topic',
    target_nesting: 0,
    firstTagMatch: true,
    tagMatches: 1,
    labelMatch: true,
    prefixMatch: true,
    ...topicMatching,
  })
  const matchingLogs = _.times(50, i =>
    item(`m_${i}`, NOW - (i + 1) * HOUR, { log: true, firstTagMatch: true, tagMatches: 1, ...topicMatching }),
  )
  const nonMatching = _.times(15, i => item(`o_${i}`, NOW - (100 + i) * HOUR, { log: true, matching: false }))
  const corpus = [...pins, target, ...matchingLogs, ...nonMatching]

  const init = runRanking({ items: corpus, text: '#topic', lastRankedQuery: '', editorTextModified: true })
  expect(init.hideIndex).toBe(6)
  // one Show more click reveals first step [6, 15)
  const expanded = init.toggles[0].end
  const droppedLog = corpus[8]
  droppedLog.editing = true
  const opened = runRanking({
    items: corpus,
    text: '#topic',
    lastRankedQuery: init.lastRankedQuery,
    hideIndex: expanded,
    itemIdsOnLastEditorChange: init.itemIdsOnLastEditorChange,
  })
  expect(opened.passes).toBe(1)
  expect(droppedLog.editingPromoted).toBe(false)

  // save with #topic removed: no longer matches, would land in non-matching step past expanded cutoff
  droppedLog.matching = false
  droppedLog.firstTagMatch = false
  droppedLog.tagMatches = 0
  droppedLog.matchingTerms = []
  const afterDrop = runRanking({
    items: corpus,
    text: '#topic',
    lastRankedQuery: opened.lastRankedQuery,
    hideIndex: opened.hideIndex,
    itemIdsOnLastEditorChange: opened.itemIdsOnLastEditorChange,
  })
  expect(afterDrop.errors).toEqual([])
  expect(
    {
      promoted: droppedLog.editingPromoted,
      idx: corpus.findIndex(i => i.id == droppedLog.id),
      visible: corpus.findIndex(i => i.id == droppedLog.id) < afterDrop.hideIndex,
      passes: afterDrop.passes,
    },
    'non-matching log saved past cutoff is promoted directly below target and kept visible',
  ).toEqual({ promoted: true, idx: 6, visible: true, passes: 2 })

  // 2. Near move: an in-place log whose step starts at or below prior cutoff stays unpromoted in place
  const subLogs = _.times(15, i =>
    item(`sub_${i}`, NOW - (50 + i) * HOUR, { log: true, firstTagMatch: false, tagMatches: 1, ...topicMatching }),
  )
  const nearCorpus = [
    ..._.times(5, i => item(`np_${i}`, NOW - 1000 * HOUR, { pinned: true, aboveFold: true })),
    item('ntopic', NOW + 2, {
      target: true,
      uniqueLabel: '#topic',
      target_nesting: 0,
      firstTagMatch: true,
      tagMatches: 1,
      labelMatch: true,
      prefixMatch: true,
      ...topicMatching,
    }),
    ..._.times(20, i =>
      item(`nm_${i}`, NOW - (i + 1) * HOUR, { log: true, firstTagMatch: true, tagMatches: 1, ...topicMatching }),
    ),
    ...subLogs,
  ]
  const nearInit = runRanking({ items: nearCorpus, text: '#topic', lastRankedQuery: '', editorTextModified: true })
  const nearLog = nearCorpus[7]
  nearLog.editing = true
  // expand to end of first step (16): next step [16, 36) starts at 16 <= 16, holding destination index 25
  const nearExpanded = nearInit.toggles[0].end
  expect(nearExpanded).toBe(16)
  nearLog.firstTagMatch = false
  const afterNear = runRanking({
    items: nearCorpus,
    text: '#topic',
    lastRankedQuery: nearInit.lastRankedQuery,
    hideIndex: nearExpanded,
    itemIdsOnLastEditorChange: nearInit.itemIdsOnLastEditorChange,
  })
  expect(afterNear.errors).toEqual([])
  expect(afterNear.passes, 'near move does not restart').toBe(1)
  expect(nearLog.editingPromoted, 'near move stays unpromoted').toBe(false)
  const nearIdx = nearCorpus.findIndex(i => i.id == nearLog.id)
  expect(nearIdx, 'near move stays in time order among subtag logs (not promoted to 6)').toBe(25)
  expect(nearIdx).toBeLessThan(afterNear.hideIndex)

  // 3. Leading slash (' /needle' -> '/needle') disables search while rankedQuery stays equal: promoted into view
  const slashOldLog = item('slash_old', NOW - 500 * HOUR, {
    log: true,
    editing: true,
    matching: true,
    matchingTerms: ['/needle'],
    aboveFold: false,
  })
  const slashCorpus = [
    ..._.times(5, i => item(`sp_${i}`, NOW - 1000 * HOUR, { pinned: true, aboveFold: true })),
    slashOldLog,
    ..._.times(40, i => item(`sn_${i}`, NOW - (i + 1) * HOUR, { matching: false, aboveFold: false })),
  ]
  const slashBefore = runRanking({
    items: slashCorpus,
    text: ' /needle',
    lastRankedQuery: '/needle',
    context: [],
    listing: [],
    hideIndex: 6,
    itemIdsOnLastEditorChange: slashCorpus.map(i => i.id),
  })
  expect(slashBefore.passes).toBe(1)
  expect(slashOldLog.editingPromoted).toBe(false)

  // removing the leading space disables matching (terms = []) while rankedQuery stays '/needle'
  slashOldLog.matching = false
  slashOldLog.matchingTerms = []
  const slashAfter = runRanking({
    items: slashCorpus,
    text: '/needle',
    lastRankedQuery: slashBefore.lastRankedQuery,
    context: [],
    listing: [],
    hideIndex: 6,
    itemIdsOnLastEditorChange: slashBefore.itemIdsOnLastEditorChange,
    editorTextModified: true,
  })
  expect(slashAfter.errors).toEqual([])
  expect(slashAfter.passes, 'leading-slash drop promotes and restarts').toBe(2)
  expect(slashOldLog.editingPromoted, 'old log hidden by leading slash is promoted').toBe(true)
  const slashIdx = slashCorpus.findIndex(i => i.id == slashOldLog.id)
  expect(slashIdx, 'promoted log ranks right after global pins').toBe(5)
  expect(slashIdx).toBeLessThan(slashAfter.hideIndex)
})

test('an in-place log in the same step as a counting editor stays unpromoted when that step raises the cutoff past it', () => {
  const mk = (i: number, state: object = {}) => item(`s_${i}`, NOW - i * HOUR, state)
  const steps = [
    { start: 5, end: 15 },
    { start: 15, end: 35 },
    { start: 35, end: 52 },
  ]

  // 1. Non-log editor (38) and deeper in-place log (45) in the same step [35, 52), with prior cutoff (15) below step.start:
  // the non-log editor raises hideIndexMinimal to 52, so the log at 45 is already in view and must stay unpromoted
  const withNonLog = _.times(52, i =>
    mk(i, i == 38 ? { editing: true } : i == 45 ? { log: true, editing: true } : { log: true }),
  )
  const nonLogRes = runFloor({ items: withNonLog, toggles: steps, hideIndex: 15 })
  expect(
    {
      restarted: nonLogRes.restarted,
      promoted: withNonLog[45].editingPromoted,
      hideIndexMinimal: nonLogRes.hideIndexMinimal,
      hideIndex: nonLogRes.hideIndex,
    },
    'in-place log covered by a non-log editor in the same step stays unpromoted without restarting',
  ).toEqual({ restarted: false, promoted: false, hideIndexMinimal: 52, hideIndex: 52 })

  // 2. Promoted log editor (38) and deeper in-place log (45) in the same step [35, 52), prior cutoff 15: same result
  const withPromoted = _.times(52, i =>
    mk(
      i,
      i == 38 ? { log: true, editing: true, editingPromoted: true } : i == 45 ? { log: true, editing: true } : { log: true },
    ),
  )
  const promotedRes = runFloor({ items: withPromoted, toggles: steps, hideIndex: 15 })
  expect(
    {
      restarted: promotedRes.restarted,
      promoted: withPromoted[45].editingPromoted,
      hideIndexMinimal: promotedRes.hideIndexMinimal,
      hideIndex: promotedRes.hideIndex,
    },
    'in-place log covered by a promoted editor in the same step stays unpromoted without restarting',
  ).toEqual({ restarted: false, promoted: false, hideIndexMinimal: 52, hideIndex: 52 })

  // 3. Full ranking under #log after a manual hide click lowers hideIndex below [15, 35):
  // 5 global pins (0..4), 12 #_log/pin (5..16), non-log editor (17), and 35 #log items (18..52) with log at 24 edited in place
  const logMatching = { matching: true, matchingTerms: ['#log'], aboveFold: false }
  const pins = _.times(5, i => item(`lp_${i}`, NOW - 1000 * HOUR, { pinned: true, aboveFold: true }))
  const logPins = _.times(12, i =>
    item(`lpm_${String(i).padStart(2, '0')}`, NOW - 900 * HOUR, {
      pinnedMatch: true,
      pinnedMatchTerm: `#_log/pin/${String(i).padStart(2, '0')}`,
      ...logMatching,
    }),
  )
  const nonLogEdit = item('non_log_edit', NOW, { editing: true, aboveFold: false })
  const logs = _.times(35, i =>
    item(`log_${i}`, NOW - (i + 1) * HOUR, {
      log: true,
      editing: i == 6,
      firstTagMatch: true,
      tagMatches: 1,
      ...logMatching,
    }),
  )
  const inPlaceLog = logs[6]
  const corpus = [...pins, ...logPins, nonLogEdit, ...logs]

  const res = runRanking({
    items: corpus,
    text: '#log',
    lastRankedQuery: '#log',
    hideIndex: 10,
    itemIdsOnLastEditorChange: corpus.map(i => i.id),
  })
  expect(res.errors).toEqual([])
  const logIdx = corpus.findIndex(i => i.id == inPlaceLog.id)
  expect(
    { passes: res.passes, promoted: inPlaceLog.editingPromoted, logIdx, hideIndex: res.hideIndex },
    'in-place log stays in time order at index 24 without promotion when step [15, 35) already reveals it',
  ).toEqual({ passes: 1, promoted: false, logIdx: 24, hideIndex: 35 })
  expect(logIdx).toBeLessThan(res.hideIndex)
})

test('an in-place log pinned above a newly unique target stays in time order after target trimming (review 8)', () => {
  // Review 8 finding 2: under #topic with 2 notes labeled #topic, older edited draft carries #_log #_topic/pin/a,
  // 35 notes carry #_topic/pin/b, and 16 newer logs carry #_topic/pin/z. Saving the draft as #log draft #topic #_topic/pin/z
  // makes the other #topic the unique target at index 52, so target trimming raises hideIndexMinimal to 53 and covers
  // the draft at index 51 without promoting it ahead of its 16 newer peers (index 35).
  const topicMatching = { matching: true, matchingTerms: ['#topic'], aboveFold: false }
  const draft = item('draft', NOW - 100 * HOUR, {
    log: true,
    editing: false,
    pinnedMatch: true,
    pinnedMatchTerm: '#_topic/pin/a',
    firstTagMatch: true,
    tagMatches: 1,
    ...topicMatching,
    aboveFold: true,
  })
  const other = item('other', NOW - 50 * HOUR, {
    firstTagMatch: true,
    tagMatches: 1,
    ...topicMatching,
  })
  const pinBs = _.times(35, i =>
    item(`pinb_${String(i).padStart(2, '0')}`, NOW - (60 + i) * HOUR, {
      pinnedMatch: true,
      pinnedMatchTerm: '#_topic/pin/b',
      ...topicMatching,
      aboveFold: i < 4, // first 5 rows above fold in single column (draft + pinb_00..03)
    }),
  )
  const peerZs = _.times(16, i =>
    item(`peerz_${String(i).padStart(2, '0')}`, NOW - (10 + i) * HOUR, {
      log: true,
      pinnedMatch: true,
      pinnedMatchTerm: '#_topic/pin/z',
      firstTagMatch: true,
      tagMatches: 1,
      ...topicMatching,
    }),
  )
  const all = [draft, other, ...pinBs, ...peerZs]

  // 1. Initial search #topic (2 notes labeled #topic -> no unique target yet), then open draft in place at index 0
  const s0 = runRanking({
    items: all,
    text: '#topic',
    lastRankedQuery: '',
    context: ['#topic'],
    listing: [],
    editorTextModified: true,
  })
  expect(s0.errors).toEqual([])
  expect(all.findIndex(i => i.id == draft.id), 'draft starts at index 0').toBe(0)
  expect(s0.hideIndex, 'initial search shows 15 rows').toBe(15)

  draft.editing = true
  const s1 = runRanking({
    items: all,
    text: '#topic',
    lastRankedQuery: s0.lastRankedQuery,
    context: ['#topic'],
    listing: [],
    hideIndex: s0.hideIndex,
    itemIdsOnLastEditorChange: s0.itemIdsOnLastEditorChange,
  })
  expect(s1.errors).toEqual([])
  expect(s1.passes).toBe(1)
  expect(s1.hideIndex, 'opening draft keeps cutoff at 15').toBe(15)
  expect(draft.editingPromoted, 'draft is opened in place').toBe(false)

  // 2. Save draft as `#log draft #topic #_topic/pin/z`: other becomes the unique #topic target at index 52,
  // and draft ranks behind its 16 newer /z peers at index 51
  draft.pinnedMatchTerm = '#_topic/pin/z'
  draft.aboveFold = false
  pinBs[4].aboveFold = true // first 5 rows in single column are now pinb_00..04
  other.target = true
  other.uniqueLabel = '#topic'
  other.target_nesting = 0
  other.labelMatch = true
  other.prefixMatch = true
  const s2 = runRanking({
    items: all,
    text: '#topic',
    lastRankedQuery: s1.lastRankedQuery,
    context: ['#topic'],
    listing: ['#topic'],
    hideIndex: s1.hideIndex,
    itemIdsOnLastEditorChange: s1.itemIdsOnLastEditorChange,
  })
  expect(s2.errors).toEqual([])
  const draftIdx = all.findIndex(i => i.id == draft.id)
  const targetIdx = all.findIndex(i => i.id == other.id)
  expect(
    { passes: s2.passes, promoted: draft.editingPromoted, draftIdx, targetIdx, hideIndex: s2.hideIndex },
    'target trimming raises cutoff to 53 before filtering, leaving pinned draft unpromoted at index 51',
  ).toEqual({ passes: 1, promoted: false, draftIdx: 51, targetIdx: 52, hideIndex: 53 })
})
