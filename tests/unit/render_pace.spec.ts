import { expect, test } from '@playwright/test'
import { nextRenderChunk } from '../../src/render_pace.js'

// the render pace (see src/render_pace.ts): the next turn's size from the previous turn's cost
for (const [what, rendered, elapsed, expected] of [
  ['ten items in 550 ms (a 55 ms item): one at a time', 10, 550, 1],
  ['one item in 55 ms: still one', 1, 55, 1],
  ['one item in 20 ms: three fit the budget', 1, 20, 3],
  ['two items in 30 ms: four', 2, 30, 4],
  ['ten cheap items in 12 ms: capped at ten', 10, 12, 10],
  ['no measurable time: the cap', 5, 0, 10],
  ['nothing rendered: one', 0, 100, 1],
] as const)
  test(`render pace: ${what}`, () => expect(nextRenderChunk(rendered, elapsed, 60)).toBe(expected))

test('render pace: a custom cap bounds the growth', () => expect(nextRenderChunk(10, 1, 60, 4)).toBe(4))

// the recurrence as renderRange runs it (a FIXED cap, never the previous size): expensive turns
// shrink to one item, cheap turns grow back
test('render pace recurrence: shrinks to one on expensive turns and recovers on cheap ones under the fixed cap', () => {
  const CAP = 10
  const turns = [550, 10, 10, 8] // wall time of successive turns
  const sizes: number[] = []
  let chunk = 10
  for (const elapsed of turns) {
    chunk = nextRenderChunk(chunk, elapsed, 60, CAP)
    sizes.push(chunk)
  }
  expect(sizes).toEqual([1, 6, 10, 10])
})
