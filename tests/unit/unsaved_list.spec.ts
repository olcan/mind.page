import { expect, test } from '@playwright/test'

import {
  UNSAVED_LIST_MAX,
  UNSAVED_NAME_MAX,
  reloadQuestion,
  unsavedListHtml,
  unsavedName,
  unsavedNotice,
  unsavedText,
  type UnsavedEntry,
} from '../../src/unsaved_list.js'

// the unsaved items by name (src/unsaved_list.ts): an item's name, a name as text and nothing
// else, the list's one line of markup, and the two dialogs' contents. The browser row that shows
// the list in the app's real dialog, with hostile names, is in tests/e2e/lifecycle.spec.ts

const ZWSP = String.fromCharCode(0x200b)
// every tag in a piece of markup, by its name with a slash for a closing one
const tags = (html: string) => [...html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)/g)].map(m => m[1] + m[2])
const entry = (name: string, state: UnsavedEntry['state'] = 'editing'): UnsavedEntry => ({ name, state })

test("an item's name is its own label, else the first line of its text that has words", () => {
  expect([
    unsavedName('#note', 'other words'),
    unsavedName('  #note  ', ''),
    unsavedName('', 'first line\nsecond line'),
    unsavedName(null, '\n  \n  the third   line  has\twords \nmore'),
    unsavedName(undefined, undefined),
    unsavedName('', ' \n\t\n'),
  ]).toEqual(['#note', '#note', 'first line', 'the third line has words', 'an empty item', 'an empty item'])
})

test('an item without a label of its own carries the reference that finds it, so two of them never read alike', () => {
  // two entries of a log share its label and can share their words: the reference tells them apart
  const [first, second] = [unsavedName('', '#log fixed the reload', 'id:AAAA1111'), unsavedName('', '#log fixed the reload', 'id:BBBB2222')]
  expect([first, second]).toEqual(['#log fixed the reload (id:AAAA1111)', '#log fixed the reload (id:BBBB2222)'])
  expect([
    unsavedName('#note', 'other words', 'id:AAAA1111'), // a label of its own needs none
    unsavedName('', '', 'id:AAAA1111'),
    unsavedName('', 'x'.repeat(UNSAVED_NAME_MAX + 5), 'id:AAAA1111'), // the cut is the words', never the reference's
    unsavedName('', 'words', `  id:AA${ZWSP}AA\n1111 `),
    unsavedName('', 'words', null),
  ]).toEqual(['#note', 'an empty item (id:AAAA1111)', 'x'.repeat(UNSAVED_NAME_MAX) + '… (id:AAAA1111)', 'words (id:AAAA 1111)', 'words'])
})

test('a name is cut at whole characters, and the zero-width spaces of the editor are left out', () => {
  const long = 'x'.repeat(UNSAVED_NAME_MAX + 5)
  const exact = 'y'.repeat(UNSAVED_NAME_MAX)
  const pairs = '😀'.repeat(UNSAVED_NAME_MAX + 1) // each one is two code units
  const spaced = 'z'.repeat(UNSAVED_NAME_MAX - 1) + ' tail'
  expect([
    unsavedName('', long),
    unsavedName('', exact),
    unsavedName('', pairs),
    unsavedName('', spaced),
    unsavedName(`#la${ZWSP}bel`, ''),
    unsavedName('', `https://exam${ZWSP}ple.com/a${ZWSP}b`),
  ]).toEqual([
    'x'.repeat(UNSAVED_NAME_MAX) + '…',
    exact,
    '😀'.repeat(UNSAVED_NAME_MAX) + '…',
    'z'.repeat(UNSAVED_NAME_MAX - 1) + '…', // (the space before the cut is not kept)
    '#label',
    'https://example.com/ab',
  ])
})

test('a text is shown as its characters: markup escaped, on one line, and no address left for a link', () => {
  expect(unsavedText(`<img src=x onerror="hit()"> & 'q' \`c\``)).toBe('&#60;img src=x onerror=&#34;hit()&#34;&#62; &#38; &#39;q&#39; &#96;c&#96;')
  expect(unsavedText('a\n\nb\tc  d')).toBe('a b c d')
  expect(unsavedText('see https://evil.example/a and http://evil.example/b, ftp://x')).toBe('see https&#58;//evil.example/a and http&#58;//evil.example/b, ftp&#58;//x')
  // an entity typed by hand stays text too: its ampersand is escaped, so it names no address
  expect(unsavedText('https&#58;//evil.example')).toBe('https&#38;#58;//evil.example')
})

test('the list is one line of markup with the names as text, whatever they hold', () => {
  const hostile = [
    '<img src=x onerror="window.__hit=1">',
    '<script>window.__hit=1</script>',
    '[a link](https://evil.example/a) ![pic](https://evil.example/p)',
    'two\n\nparagraphs # heading\n- item',
    '</li></ul><a href="https://evil.example">out</a>',
    '#tag `code` *bold* _it_ ~~no~~ $x$',
  ]
  const html = unsavedListHtml(hostile.map(name => entry(name)))
  expect(html.includes('\n'), 'one line').toBe(false)
  expect(html.includes('://'), 'no address a link could be made of').toBe(false)
  // the list's own tags and no other: one `ul`, and for each item a `li` with its two `span`s
  expect(tags(html)).toEqual(['ul', ...hostile.flatMap(() => ['li', 'span', '/span', 'span', '/span', '/li']), '/ul'])
  for (const name of hostile) expect(html, name).toContain(`<span class="name">${unsavedText(name)}</span>`)
})

test('each item says what would be lost of it, and an unknown state reads as not saved', () => {
  const html = unsavedListHtml([entry('a', 'editing'), entry('b', 'saving'), entry('c', 'unsaved'), entry('d', 'other' as UnsavedEntry['state'])])
  expect([...html.matchAll(/<span class="state"[^>]*>([^<]*)<\/span>/g)].map(m => m[1])).toEqual([
    '(being edited)',
    '(being saved)',
    '(not saved)',
    '(not saved)',
  ])
})

test('a long list names its first items and counts the rest', () => {
  const many = Array.from({ length: UNSAVED_LIST_MAX + 3 }, (_, i) => entry(`item ${i + 1}`))
  const html = unsavedListHtml(many)
  expect((html.match(/<span class="name">/g) ?? []).length).toBe(UNSAVED_LIST_MAX)
  expect(html).toContain(`<span class="name">item ${UNSAVED_LIST_MAX}</span>`)
  expect(html).not.toContain(`item ${UNSAVED_LIST_MAX + 1}<`)
  expect(html).toMatch(/<li class="more"[^>]*>and 3 more<\/li><\/ul>$/)
  // at the limit and under it nothing is counted
  expect(unsavedListHtml(many.slice(0, UNSAVED_LIST_MAX))).not.toContain('more')
  expect(unsavedListHtml([entry('one')], 1)).not.toContain('more')
  expect(unsavedListHtml([entry('one'), entry('two')], 1)).toContain('and 1 more')
})

test("the reload question keeps its words, with the list under them; the notice counts the items", () => {
  const one = [entry('#note', 'unsaved')]
  const two = [entry('#note', 'unsaved'), entry('words', 'saving')]
  expect(reloadQuestion(one)).toBe(`Reload and discard unsaved changes?\n\n${unsavedListHtml(one)}`)
  // (the notice speaks of the moment the box was asked for: an item may have been saved since)
  expect(unsavedNotice(one)).toBe(`When the page was about to go, one item had unsaved changes:\n\n${unsavedListHtml(one)}`)
  expect(unsavedNotice(two)).toBe(`When the page was about to go, 2 items had unsaved changes:\n\n${unsavedListHtml(two)}`)
})
