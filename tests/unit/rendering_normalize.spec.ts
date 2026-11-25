import { expect, test } from '@playwright/test'
import { normalize } from '../e2e/rendering.js'

// the golden normalizer's handling of a retried external image (Item.svelte's one retry, see
// tests/e2e/rendering.ts): the generated markers go, nothing else does (review 0 R2 of the
// image_retry thread: a document-wide replacement erased authored text and links)
test('the retry markers are stripped inside the retried image alone, with the query and fragment kept', () => {
  const retried = (src: string) => normalize(`<img src="${src}" _retried="1790000000000">`)
  expect(retried('https://example.test/x.png?_retry=1790000000000')).toBe('<img src="https://example.test/x.png">')
  expect(retried('https://example.test/x.png?size=2&amp;_retry=1790000000000')).toBe('<img src="https://example.test/x.png?size=2">')
  expect(retried('https://example.test/x.png?size=2&amp;_retry=1790000000000#view')).toBe('<img src="https://example.test/x.png?size=2#view">')
  expect(retried('https://example.test/x.png?_retry=1790000000000#view')).toBe('<img src="https://example.test/x.png#view">')
  // authored text and links are untouched, retried or not
  const authored = '<p>Example: ?_retry=123</p><a href="https://example.test/?_retry=123">retry</a>'
  expect(normalize(authored)).toBe('<p>Example: ?_retry=123</p>\n<a href="https://example.test/?_retry=123">retry</a>')
  // an image that was not retried keeps a `_retry` an author wrote
  expect(normalize('<img src="https://example.test/x.png?_retry=1">')).toBe('<img src="https://example.test/x.png?_retry=1">')
})

// a chart shape's style attribute stands where chrome first wrote it out (see
// tests/e2e/rendering.ts): after the shape's drawing in a chart taken from the element cache,
// before it in a bar chart generated while a golden row is at its item. the row `every anonymous
// item renders as before` failed on that alone in two gates of 2026-11-24
test("a chart shape's style compares last, wherever chrome wrote it out", () => {
  const chart = (shape: string) => `<div class="c3"><svg>${shape}</svg></div>`
  const bar = (attrs: string) => chart(`<path class=" c3-shape c3-bar"${attrs}></path>`)
  const drawn_first = normalize(bar(' d="M 1,2 L 3,4" style="fill: rgb(1, 2, 3); opacity: 1;"'))
  expect(drawn_first).toContain('<path class=" c3-shape c3-bar" d="PATH" style="fill: rgb(1, 2, 3); opacity: 1;">')
  expect(normalize(bar(' style="opacity: 1; fill: rgb(1, 2, 3);" d="M 9,9"'))).toBe(drawn_first)
  const circle = (attrs: string) => chart(`<circle shape-rendering="crispEdges" class=" c3-shape c3-circle"${attrs}></circle>`)
  expect(normalize(circle(' style="fill: red;" cx="1" cy="2" r="3"'))).toBe(normalize(circle(' cx="5" cy="6" r="7" style="fill: red;"')))
  // what is no shape keeps its order, in a chart (an axis label) and outside one
  const label = '<text class="c3-axis-x-label" style="text-anchor: end;" x="1"></text>'
  expect(normalize(chart(label))).toContain('<text class="c3-axis-x-label" style="text-anchor: end;" x="N">')
  const outside = '<svg><path class="c3-shape" style="fill: red;" d="M 1,2"></path></svg>'
  expect(normalize(outside)).toBe('<svg>\n<path class="c3-shape" style="fill: red;" d="M 1,2">\n</path>\n</svg>')
})
