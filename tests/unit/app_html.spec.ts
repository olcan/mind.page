import { expect, test } from '@playwright/test'
import { readFileSync } from 'fs'

// the app shell's script ORDER is the guarantee that item code cannot evaluate before the globals
// it uses (c3, hljs, graphviz, ...) exist: kit's bootstrap is an inline import(), which unlike
// sapper's classic bundle tag is not parser-ordered, so the cdn tags must sit ABOVE the app
// container. browser parser ordering for classic, non-async/non-defer scripts is deterministic,
// which makes this structural check strictly stronger than the browser test it replaces — that one
// held one script and polled for "the app has not booted", and `expect.poll(...).toBe(false)`
// returns on its FIRST sample, so it passed whether or not startup had been reordered.
// that the libraries actually EXECUTE is proven by the chart tests in tests/e2e/render.spec.ts
const html = readFileSync(new URL('../../src/app.html', import.meta.url), 'utf8')

test('every cdn script is classic, parser-blocking, and above the app container', () => {
  const body = html.indexOf('%sveltekit.body%')
  expect(body, '%sveltekit.body% is present').toBeGreaterThan(-1)
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="(https:\/\/[^"]+)"[^>]*>/g)]
  expect(scripts.length, 'the shell loads cdn scripts').toBeGreaterThan(0)
  for (const script of scripts) {
    const [tag, src] = script
    expect(script.index, `${src} precedes the app container`).toBeLessThan(body)
    // async/defer would release the parser and reintroduce exactly the race this ordering closes
    expect(tag, `${src} is parser-blocking`).not.toMatch(/\basync\b|\bdefer\b/)
    expect(tag, `${src} is a classic script`).not.toMatch(/type="module"/)
  }
  // the globals the item runtime reaches for, pinned by name so removing one is a deliberate act
  for (const global of ['c3', 'highlight', 'mathjax', 'hpcc-js/wasm'])
    expect(html.slice(0, body), `${global} is loaded above the app container`).toContain(global)
})
