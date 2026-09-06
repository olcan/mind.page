import { expect, test } from '@playwright/test'
import {
  collectItemErrorSources,
  describeItemErrors,
  makeItemErrorLogger,
  type ErrorElement,
  type ItemErrorSources,
} from '../../src/item_errors.js'

// the red-border diagnostics (src/item_errors.ts): the collector reads the rendered causes at
// the border's dom inspection seam, every cause gets an actionable reason, and the logger
// dedupes per item until the item recovers. the browser witness for the real seam is in
// tests/e2e/editor.spec.ts (a transitive missing dependency)

// a rendered element stand-in: tag name, classes, displayed text, title (the producers put the
// resolved absolute tag in a missing mark's title and a shortened tag or link caption in its text)
type Stub = { tag: string; classes: string[]; text: string; title: string | null }
const el = (tag: string, classes: string[], text = '', title: string | null = null): Stub => ({ tag, classes, text, title })
const matches = (e: Stub, selector: string) => {
  const [, tag, classes] = selector.match(/^([a-z]*)((?:\.[a-z-]+)*)$/)!
  return (!tag || e.tag == tag) && classes.split('.').filter(Boolean).every(c => e.classes.includes(c))
}
const element = (e: Stub): ErrorElement => ({
  getAttribute: (name: string) => (name == 'title' ? e.title : null),
  textContent: e.text,
  classList: { contains: (c: string) => e.classes.includes(c) },
  matches: (selector: string) => matches(e, selector),
})
const root = (stubs: Stub[]) => ({
  querySelectorAll: (selector: string) => stubs.filter(e => matches(e, selector)).map(element),
})

const none: ItemErrorSources = { macroErrors: [], missingTags: [], consoleErrorIndicators: 0, genericErrors: 0 }

test('collects rendered causes by resolved identity and skips exact known sources among generic errors', () => {
  const sources = collectItemErrorSources(
    root([
      el('span', ['macro-error'], 'command_table()', 'eval missing dependencies: util/core'),
      el('span', ['macro-error'], 'command_table()', 'eval missing dependencies: util/core'), // repeated
      el('span', ['macro-error'], 'boom()', ''), // a macro error without a message
      // a visible occurrence first, then the hidden one: one identity, classified as a dependency
      el('mark', ['missing'], 'foo', '#foo'),
      el('mark', ['hidden', 'missing'], 'foo', '#foo'),
      // markdown tag links display captions; the titles keep the two targets apart
      el('mark', ['link', 'missing'], 'Read this', '#first'),
      el('mark', ['link', 'missing'], 'Read this', '#second'),
      el('mark', ['missing'], '#…/deep', '#a/very/deep'), // a shortened hierarchical tag
      el('mark', ['missing'], '#untitled', null), // no title: the displayed text is the fallback
      // one log ERROR line renders a content span AND a log-summary indicator; prose ERROR: too
      el('span', ['console-error'], 'ERROR: boom'),
      el('span', ['console-error'], '●'),
      el('span', ['console-error'], 'ERROR: in prose'),
      // generic errors: item-authored markup, incl. one that also carries `missing` (not a mark)
      el('span', ['error'], 'failure'),
      el('span', ['error', 'missing'], 'failure'),
      el('span', ['error', 'console-error'], 'ERROR: known source, not generic'),
      // not red: warnings and a plain code block that merely contains the word
      el('span', ['console-warn'], 'WARNING: careful'),
      el('div', ['warning'], 'careful'),
      el('code', [], 'ERROR: text inside an ordinary code block'),
    ])
  )
  expect(sources).toEqual({
    macroErrors: ['eval missing dependencies: util/core', ''],
    missingTags: [
      { tag: '#foo', hidden: true },
      { tag: '#first', hidden: false },
      { tag: '#second', hidden: false },
      { tag: '#a/very/deep', hidden: false },
      { tag: '#untitled', hidden: false },
    ],
    consoleErrorIndicators: 4,
    genericErrors: 2,
  })
  expect(collectItemErrorSources(root([]))).toEqual(none)
  expect(collectItemErrorSources(root([el('span', ['console-warn'], 'WARNING: only'), el('div', ['warning'])]))).toEqual(none)
})

test('describes each cause with a hint, in a fixed order', () => {
  expect(describeItemErrors(none)).toEqual([])
  const reasons = describeItemErrors({
    macroErrors: ['eval missing dependencies: agent/vault, util/core', 'x is not defined', ''],
    missingTags: [
      { tag: '#agent/vault', hidden: true },
      { tag: '#nope', hidden: false },
      { tag: '#other', hidden: false },
    ],
    consoleErrorIndicators: 1,
    genericErrors: 2,
  })
  expect(reasons).toEqual([
    'macro error: eval missing dependencies: agent/vault, util/core (ensure each named dependency has' +
      ' one uniquely labelled item: install or restore missing items, or resolve duplicate labels;' +
      ' dependencies can be transitive)',
    'macro error: x is not defined',
    'macro error without a message (the failing macro is outlined in the content)',
    '1 missing hidden tag: #agent/vault (a hidden tag is a dependency and needs one uniquely labelled item)',
    '2 missing tags: #nope #other (no other item carries the tag: add it to an item or remove it)',
    '1 rendered console-error indicator (ERROR lines in log blocks, each also summarized, or ERROR: prose)',
    '2 elements with the error class in the rendered content',
  ])
  // a dependency that is also missing as a visible tag gets ONLY the dependency remedy
  expect(describeItemErrors({ ...none, missingTags: [{ tag: '#foo', hidden: true }] })).toEqual([
    '1 missing hidden tag: #foo (a hidden tag is a dependency and needs one uniquely labelled item)',
  ])
})

test('logs once per item until the reasons change, and again after recovery', () => {
  const lines: string[] = []
  const logItemErrors = makeItemErrorLogger((m: string) => lines.push(m))
  const failing: ItemErrorSources = { ...none, macroErrors: ['eval missing dependencies: util/core'] }
  logItemErrors('id1', 'chat/fable', failing)
  logItemErrors('id1', 'chat/fable', failing) // same fingerprint: silent
  expect(lines).toEqual([
    '[chat/fable] error indication due to: macro error: eval missing dependencies: util/core (ensure each' +
      ' named dependency has one uniquely labelled item: install or restore missing items, or resolve' +
      ' duplicate labels; dependencies can be transitive)',
  ])
  logItemErrors('id1', 'chat/fable', { ...failing, genericErrors: 1 }) // changed: logs again
  expect(lines).toHaveLength(2)
  expect(lines[1]).toContain('1 element with the error class')
  logItemErrors('id2', 'other', failing) // another item: its own line
  expect(lines).toHaveLength(3)
  logItemErrors('id1', 'chat/fable', none) // recovered: forgotten
  logItemErrors('id1', 'chat/fable', failing) // the same failure again: logs again
  expect(lines).toHaveLength(4)
})
