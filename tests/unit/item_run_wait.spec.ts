import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

// the REAL run handler (index.svelte `onItemRun`, extracted by name and stripped of its types) with small
// fakes, for a run that WAITS for a preview while the page changes under it. Every item here is an
// installed one, whose run makes a `/run` item: the fake `_create` records what was dispatched (the run
// item's name, its `run` option and its input). One unrelated item is previewable, so that every run waits
// for the row's own promise; the row removes, replaces or moves a record, or changes a draft, and releases
const source = readFileSync(resolve(process.cwd(), 'src/routes/index.svelte'), 'utf8')
const declared = source.match(/\n {2}function onItemRun\([\s\S]*?\n {2}\}\n/)?.[0]
if (!declared) throw new Error('onItemRun not found in index.svelte')
const compiled = ts.transpileModule(declared, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
// the handler's free variables on the paths these rows take, in the order `world` supplies them
const FREE = ['items', 'indexFromId', 'focusedItem', '_item', '__item', 'countRunning', 'carryInput', 'previewItem', '_modal', 'inputBlockRegExp', 'editInertText', 'editorText', 'disableScrollingOnLayout', 'lastEditorChangeTime', 'forceNewStateOnEditorChange', 'onEditorChange', 'textArea', '_create', 'hash', 'confirm']

type Rec = { id: string; index: number; name: string; label: string; text: string; attr: { source: string } | null; deps: string[]; runnable: boolean; editing: boolean; editorText: string; previewable: boolean }
const FENCE = '```'
const text = (id: string, input: string) => `#${id}\n${FENCE}js_input\n${input}\n${FENCE}`
const installed = (id: string, input: string, more: Partial<Rec> = {}): Rec => ({ id, index: -1, name: '#' + id, label: '#' + id, text: text(id, input), attr: { source: 'repo' }, deps: [], runnable: true, editing: false, editorText: '', previewable: false, ...more })
// the item whose pending preview every run waits for
const previewed = () => installed('p', '0', { attr: null, runnable: false, previewable: true })

const world = (records: Rec[]) => {
  const items = [...records]
  const indexFromId = new Map<string, number>()
  const reindex = () => (indexFromId.clear(), items.forEach((item, index) => indexFromId.set(item.id, (item.index = index))))
  reindex()
  const dispatched: string[] = []
  let previews = 0
  let released!: () => void
  const held = new Promise<void>(done => (released = done))
  const handles = new Map<string, { running: boolean; status: string; global_store: Record<string, unknown> }>()
  const handle = (id: string) => handles.get(id) ?? handles.set(id, { running: false, status: '', global_store: {} }).get(id)!
  const onItemRun = new Function(...FREE, `${compiled}\nreturn onItemRun`)(
    items,
    indexFromId,
    -1,
    (id: string) => (id.endsWith('/run') ? null : handle(id)), // no run item exists yet
    (id: string) => items[indexFromId.get(id)!],
    () => {},
    (f: unknown) => f,
    () => (previews++, held),
    () => Promise.resolve(),
    () => /```js_input(?:_hidden|_removed)?[\s\S]*?```/g,
    (raw: string, edit: (grammar: string) => string) => edit(raw),
    '',
    false,
    0,
    false,
    () => {},
    () => ({ value: '' }),
    (made: string, options: { run?: boolean }) => (dispatched.push(`${made.split(' ')[0]} ${options.run} ${/\n(.*)\n```$/.exec(made)?.[1]}`), { read: () => '' }),
    (value: unknown) => String(value),
    () => true,
  ) as (index: number, e: { altKey: boolean } | null, touch_first: boolean, own_editor: boolean) => Promise<unknown>
  return {
    items,
    reindex,
    dispatched,
    previews: () => previews,
    run: (item: Rec, option = false, own_editor = false) => onItemRun(item.index, option ? { altKey: true } : null, true, own_editor),
    release: (item: Rec) => ((item.previewable = false), released()),
  }
}

test("an Option-run whose dependency is removed while that dependency's run waits for a preview stops: neither is dispatched", async () => {
  const [parent, dependency, preview] = [installed('a', '2', { deps: ['d'] }), installed('d', '1'), previewed()]
  const w = world([parent, dependency, preview])
  const option = w.run(parent, true)
  expect(w.previews(), "the dependency's run has entered the handler and waits").toBe(1)
  w.items.splice(w.items.indexOf(dependency), 1)
  w.reindex()
  w.release(preview)
  await expect(option).rejects.toThrow('item d deleted')
  expect(w.dispatched).toEqual([])
})

test('the same with the dependency replaced by a new record under its id: neither that one nor the parent is dispatched', async () => {
  const [parent, dependency, preview] = [installed('a', '2', { deps: ['d'] }), installed('d', '1'), previewed()]
  const w = world([parent, dependency, preview])
  const option = w.run(parent, true)
  w.items[w.items.indexOf(dependency)] = installed('d', '9')
  w.reindex()
  w.release(preview)
  await expect(option).rejects.toThrow('item d deleted')
  expect(w.dispatched).toEqual([])
})

test('a dependency that only MOVED to another index while its run waited runs, and then its parent', async () => {
  const [parent, dependency, preview] = [installed('a', '2', { deps: ['d'] }), installed('d', '1'), previewed()]
  const w = world([parent, dependency, preview])
  const option = w.run(parent, true)
  const oldIndex = dependency.index
  w.items.splice(0, 2, dependency, parent)
  w.reindex()
  expect(dependency.index, 'the waiting dependency itself has moved').not.toBe(oldIndex)
  w.release(preview)
  await option
  expect(w.dispatched).toEqual(['#d/run true 1', '#a/run true 2'])
})

test('a run that waited for a preview is not handed to the record that took its item\'s index', async () => {
  const [gone, other, preview] = [installed('a', '1'), installed('b', '10'), previewed()]
  const w = world([gone, other, preview])
  const run = w.run(gone)
  w.items.splice(0, 1)
  w.reindex()
  w.release(preview)
  await expect(run).rejects.toThrow('item a deleted')
  expect(w.dispatched).toEqual([])
})

test("a run from an installed item's own editor that waited for a preview runs the draft it was asked on, and nothing when that draft changed or its editor closed meanwhile", async () => {
  const edited = () => installed('a', '1', { editing: true, editorText: text('a', '2') })
  const cases: [string, (item: Rec) => void, string[]][] = [
    ['unchanged', () => {}, ['#a/run true 2']],
    ['retyped', item => void (item.editorText = text('a', '3')), []],
    ['closed', item => void (item.editing = false), []],
  ]
  for (const [name, change, expected] of cases) {
    const [item, preview] = [edited(), previewed()]
    const w = world([item, preview])
    const run = w.run(item, false, true)
    change(item)
    w.release(preview)
    await run
    expect(w.dispatched, name).toEqual(expected)
  }
})
