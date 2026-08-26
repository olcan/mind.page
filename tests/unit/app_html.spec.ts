import { expect, test } from '@playwright/test'
import { readFileSync } from 'fs'

// the app shell's script ORDER is what stops item code evaluating before the globals it uses exist:
// kit's bootstrap is an inline import(), which unlike sapper's classic bundle tag is not
// parser-ordered, so the cdn tags must sit ABOVE the app container.
//
// this pins the EXACT loaders. an earlier version searched broad substrings, and review's mutation
// testing showed that removing mathjax, d3, c3, graphviz or the core highlight loader individually
// still left it green — comments, css, configuration and auxiliary language scripts satisfied the
// tokens, and d3 was not checked at all.
//
// it cannot see kit's BOOTSTRAP, which is generated rather than written here and sits after
// %sveltekit.head% — above these tags in the source. that half is asserted against the built
// response in tests/e2e/server.spec.ts
const html = readFileSync(new URL('../../src/app.html', import.meta.url), 'utf8')

// every global the item runtime reaches for, by exact url: removing or downgrading one is then a
// deliberate edit to this list rather than something a substring search can absorb
const REQUIRED_LOADERS = [
  'https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.1.2/es5/tex-svg.min.js',
  'https://cdn.jsdelivr.net/npm/d3@5.16.0/dist/d3.min.js',
  'https://cdn.jsdelivr.net/npm/c3@0.7.2/c3.min.js',
  'https://unpkg.com/@hpcc-js/wasm@0.3.11/dist/index.min.js',
  'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js',
]

test('every required cdn loader is present, classic, parser-blocking, and above the app container', () => {
  const body = html.indexOf('%sveltekit.body%')
  expect(body, '%sveltekit.body% is present').toBeGreaterThan(-1)
  for (const src of REQUIRED_LOADERS) {
    const tag = html.match(new RegExp(`<script\\b[^>]*\\bsrc="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`))
    expect(tag, `${src} is loaded by the shell`).toBeTruthy()
    expect(tag!.index, `${src} precedes the app container`).toBeLessThan(body)
    // async/defer or type=module would release the parser and reopen exactly this race
    expect(tag![0], `${src} is parser-blocking`).not.toMatch(/\basync\b|\bdefer\b/)
    expect(tag![0], `${src} is a classic script`).not.toMatch(/type="module"/)
  }
  // and nothing ELSE that loads over https may sit below the container either
  for (const script of html.matchAll(/<script\b[^>]*\bsrc="(https:\/\/[^"]+)"[^>]*>/g))
    expect(script.index, `${script[1]} precedes the app container`).toBeLessThan(body)
})
