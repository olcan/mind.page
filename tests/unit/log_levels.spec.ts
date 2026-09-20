import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'

// the `_log` highlighter of src/util.js runs in the browser (window.hljs, the lodash global);
// the globals it reads are the minimum here, so the level rule is checked without a browser
test('a `_`-prefixed level (a neutralized WARNING or ERROR) is faded like INFO', async () => {
  const g = globalThis as Record<string, unknown>
  g.window = { hljs: {}, _shortcut_hosts: [] }
  g._ = createRequire(import.meta.url)('lodash')
  // @ts-expect-error util.js is plain js (the app's client lib) without a declaration file
  const { highlight } = await import('../../src/util.js')
  const lines = [
    'ERROR: 17:41 turn failed',
    'WARNING: 17:41 gate lint refused',
    'INFO: 17:41 worker 2 start',
    '_ERROR: 17:41 turn failed',
    '_WARNING: 17:41 gate lint refused',
    '17:41 proposal drafted',
    'INFO: 17:41 gate said ERROR: x',
  ]
  expect(highlight(lines.join('\n'), '_log').split('\n')).toEqual([
    '<span class="console-error">ERROR: 17:41 turn failed</span>',
    '<span class="console-warn">WARNING: 17:41 gate lint refused</span>',
    '<span class="console-info">INFO: 17:41 worker 2 start</span>',
    '<span class="console-info">_ERROR: 17:41 turn failed</span>',
    '<span class="console-info">_WARNING: 17:41 gate lint refused</span>',
    '17:41 proposal drafted',
    '<span class="console-info">INFO: 17:41 gate said ERROR: x</span>',
  ])
})
