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
