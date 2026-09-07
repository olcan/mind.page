import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import _ from 'lodash'
import { attrSaveStep } from '../../src/welcome.js'

// the REAL held attribute task (index.svelte `_update_attr_async`, extracted by name) with small
// fakes: a held turn must leave a null attribute map untouched — initializing it made an
// unchanged item look dirty to discardEdits (attr vs savedAttr), whose save then wrote the cached
// text before the confirmation (welcome_gate round 1). restoring `_item.attr ??= {}` ahead of the
// verdict fails the first row
const source = readFileSync(resolve(process.cwd(), 'src/routes/index.svelte'), 'utf8')
const body = source.match(/\n    _update_attr_async\(prop\) \{\n([\s\S]*?)\n    \}\n\n    get elem\(\)/)?.[1]
if (!body) throw new Error('_update_attr_async not found in index.svelte')

const witness = ({ confirmed, exists = true, stored = null }: { confirmed: boolean; exists?: boolean; stored?: any }) => {
  const window = { _server_confirmed: confirmed }
  const record = { id: 'x', attr: stored, savedAttr: _.cloneDeep(stored) } // as onEditorDone leaves a plain item
  let saves = 0
  let changed = 0
  let turn: (() => any) | undefined
  const self = { id: 'x', editable: false, editing: false, dispatch_task: (_name: string, fn: () => any) => void (turn = fn), save: () => void saves++ }
  const method = new Function(
    'attrSaveStep', '_', '_exists', 'item', 'itemAttrChanged', 'window',
    `return function (prop) {${body}}`
  )(attrSaveStep, _, () => exists, () => record, () => void changed++, window)
  method.call(self, 'editable') // the setter's dispatch
  return { record, run: () => turn!(), saves: () => saves, changed: () => changed }
}

test('a held turn (unconfirmed) retries and leaves the null attribute map untouched, with no save', () => {
  const w = witness({ confirmed: false })
  expect(w.run()).toBe(250)
  expect(w.record.attr, 'the container stays null').toBeNull()
  expect(_.isEqual(w.record.attr, w.record.savedAttr), 'discardEdits sees no dirty attr').toBe(true)
  expect(w.saves()).toBe(0)
  expect(w.changed()).toBe(0)
})

test('a confirmed turn initializes the map, mirrors the value, notifies and saves once', () => {
  const w = witness({ confirmed: true })
  expect(w.run()).toBeUndefined()
  expect(w.record.attr).toEqual({ editable: false })
  expect(w.saves()).toBe(1)
  expect(w.changed()).toBe(1)
})

test('a confirmed turn with the value already persisted saves nothing', () => {
  const w = witness({ confirmed: true, stored: { editable: false } })
  expect(w.run()).toBeUndefined()
  expect(w.saves()).toBe(0)
  expect(w.changed()).toBe(0)
})

test('a deleted item cancels before any decision', () => {
  const w = witness({ confirmed: false, exists: false })
  expect(w.run()).toBeUndefined()
  expect(w.record.attr).toBeNull()
})
