import { expect, test } from '@playwright/test'
import _ from 'lodash'

// parseTags (util.js: the app's own parser, which the label rows below read whole lines with) reads
// the browser globals `_` (lodash) and `window._shortcut_hosts` at call time; stub both before the calls
;(globalThis as any)._ = _
;(globalThis as any).window = { _shortcut_hosts: [] }

// @ts-expect-error util.js is plain js (the app's client lib) without a declaration file
import { parseTags } from '../../src/util.js'
import { Lineage, compareIntegerChildren, integerSuffix, resolveTag, type Facts } from '../../src/lineage.js'
import { insertInlineChildTags, isNameOnlyContent, labelTextOf, renderChildMarks, shortenChildTag } from '../../src/child_tags.js'

const ALIASES: Record<string, string> = {
  '#init': '#features/_init',
  '#autodep': '#features/_autodep',
}

function facts(line: string, id?: string): Facts {
  const raw = (line.toLowerCase().match(/#[^\s#]+/g) ?? []).filter(t => t != '#')
  const label = raw.find(t => !t.startsWith('#_')) ?? ''
  const hidden = raw.filter(t => t.startsWith('#_')).map(t => '#' + t.slice(2))
  const resolved = (tags: string[]) => tags.map(t => resolveTag(label, t)).filter((t): t is string => t !== undefined)
  const tagsHidden = resolved(hidden)
  const tagsHiddenAlt = Array.from(
    new Set(resolved(hidden.concat(hidden.flatMap(t => (ALIASES[t] ? [ALIASES[t]] : []))))),
  )
  return { id: id ?? label, label, tagsHidden, tagsHiddenAlt, carrier: raw.includes('#_autodep') }
}

const corpus = (...lines: (string | [string, string])[]) =>
  lines.map(l => (typeof l == 'string' ? facts(l) : facts(l[0], l[1])))

test('children order: numbered first in numeric order, then nested by name, then tag children by name', () => {
  const items = corpus(
    '#chat #_autodep',
    '#chat/vault',
    '#p',
    '#p/0 #_chat/vault #_autodep',
    '#p/0/0',
    '#p/0/0/10',
    '#p/0/0/2',
    '#p/0/0/1',
    '#p/0/0/0',
    '#p/0/0/zeta',
    '#p/0/0/alpha',
    '#p/plan-z #_p/0/0',
    '#p/plan-a #_p/0/0',
    '#p/0/0/alpha/grand',
  )
  const forward = new Lineage(items)
  const reversed = new Lineage(items.slice().reverse())
  const expected = [
    '#p/0/0/0',
    '#p/0/0/1',
    '#p/0/0/2',
    '#p/0/0/10',
    '#p/0/0/alpha',
    '#p/0/0/zeta',
    '#p/plan-a',
    '#p/plan-z',
  ]
  expect(forward.children('#p/0/0')).toEqual(expected)
  expect(reversed.children('#p/0/0')).toEqual(expected)
  // leading-zero tie-break stays deterministic regardless of input order
  const tied = corpus('#t', '#t/01', '#t/1', '#t/2')
  expect(new Lineage(tied).children('#t')).toEqual(['#t/01', '#t/1', '#t/2'])
  expect(new Lineage(tied.slice().reverse()).children('#t')).toEqual(['#t/01', '#t/1', '#t/2'])
})

test('children membership: tag-parent override moves child off textual parent; grandchildren and duplicates excluded', () => {
  const items = corpus(
    '#chat #_autodep',
    '#p',
    '#p/branch #_chat',
    '#p/1 #_p/branch',
    '#p/2',
    '#p/plan-b #_p/branch',
    '#p/missing/grand',
    ['#p/dup', 'd1'],
    ['#p/dup', 'd2'],
  )
  const lineage = new Lineage(items)
  // /1 and /plan-b moved under #p/branch; /missing/grand is not direct; /dup is non-unique
  expect(lineage.children('#p')).toEqual(['#p/2', '#p/branch'])
  // under #p/branch, /1 and /plan-b are tag children in label order (neither starts with #p/branch/)
  expect(lineage.children('#p/branch')).toEqual(['#p/1', '#p/plan-b'])
  expect(integerSuffix('#p/1', '#p/branch')).toBeNull()
  expect(integerSuffix('#p/10', '#p')).toBe(10)
  expect(integerSuffix('#p/10a', '#p')).toBeNull()
})

test('a duplicated parent label and an unlabeled item draw no children', () => {
  const lineage = new Lineage(corpus(['#dup', 'p1'], ['#dup', 'p2'], '#dup/a', '#dup/1', ['no label here', 'u1']))
  expect(lineage.children('p1')).toEqual([])
  expect(lineage.children('p2')).toEqual([])
  expect(lineage.children('u1')).toEqual([])
})

test('compareIntegerChildren: breaks equal-number ties by label regardless of creation order', () => {
  const cmp = compareIntegerChildren('#p')
  // #p/1 created BEFORE #p/01: equal numeric value still orders #p/01 before #p/1
  expect(['#p/10', '#p/1', '#p/01', '#p/2'].sort(cmp)).toEqual(['#p/01', '#p/1', '#p/2', '#p/10'])
  expect(['#p/2', '#p/01', '#p/1', '#p/10'].sort(cmp)).toEqual(['#p/01', '#p/1', '#p/2', '#p/10'])
  expect(new Lineage(corpus('#p', '#p/1', '#p/01', '#p/2')).children('#p')).toEqual(['#p/01', '#p/1', '#p/2'])
  expect(new Lineage(corpus('#p', '#p/01', '#p/1', '#p/2')).children('#p')).toEqual(['#p/01', '#p/1', '#p/2'])
})

test('isNameOnlyContent: distinguishes label-only items from items with any visible content', () => {
  const label = '<mark class="label unique" title="#map">map</mark>'
  // name-only: hidden tags, blank lines, styles, comments, hidden sections and _log do not count as content
  for (const [name, html] of [
    ['bare label', `<p>${label}</p>`],
    [
      'label with trailing hidden marks',
      `<p>${label}</p>\n<mark class="hidden" title="#pin">pin</mark> <mark class="hidden" title="#autodep">autodep</mark>\n`,
    ],
    ['label with inline hidden mark', `<p>${label} <mark class="hidden" title="#pin">pin</mark></p>`],
    ['label with blank lines and nbsp', `<p>${label}<br>&nbsp;</p><p>&nbsp;<br></p>`],
    ['label with style tag', `<p>${label} <style>#item-1 { color: red; }</style></p>`],
    ['label with newline then style', `<p>${label}<br><style>#item-1 { color: red; }</style></p>`],
    ['label with html comment', `<p>${label} <!-- note --></p>`],
    [
      'label with hidden section (nested div)',
      `<p>${label}</p>\n<div style="display: none;"><div><p>hidden</p></div></div>`,
    ],
    ['label with _log block', `<p>${label}</p>\n<pre><code class="_log">INFO: ok</code></pre>\n`],
  ]) {
    expect(isNameOnlyContent(html), name).toBe(true)
  }

  // has other content: any visible text, extra mark, missing hidden tag, list, code, frame, script or open HTML
  for (const [name, html] of [
    ['one-line description', `<p>${label} overview of the map</p>`],
    ['punctuation after label', `<p>${label}.</p>`],
    ['second paragraph', `<p>${label}</p><p>second line</p>`],
    ['list after label', `<p>${label}</p><ul><li><span class="list-item">one</span></li></ul>`],
    ['written child tag', `<p>${label} <mark title="#map/a">a</mark></p>`],
    ['repeated label mark', `<p>${label} ${label}</p>`],
    ['visible missing hidden tag', `<p>${label}</p>\n<mark class="missing hidden" title="#gone">gone</mark>\n`],
    ['code block', `<p>${label}</p><pre><code class="js">1 + 1</code></pre>`],
    ['inert frame', `<p>${label}<span class="vault-result" data-vault-marker="m1"></span></p>`],
    ['image', `<p>${label}<br><img src="/x.png"></p>`],
    ['script', `<p>${label}</p><script>1</script>`],
    ['open div wrapper', `<div><p>${label}</p>`],
    ['unclosed hidden div', `<p>${label}</p><div style="display: none;"><div>unclosed`],
    ['unlabeled item', '<p>plain text</p>'],
  ]) {
    expect(isNameOnlyContent(html), name).toBe(false)
  }
})

test('shortenChildTag, renderChildMarks, and insertInlineChildTags', () => {
  expect(shortenChildTag('#Map/Tech', '#map')).toBe('#/Tech')
  expect(shortenChildTag('#Chat/10', '#chat')).toBe('#/10')
  expect(shortenChildTag('#p/plan-b', '#p/0/0')).toBe('#/plan-b')
  expect(shortenChildTag('#p/deep/x', '#p/0/0')).toBe('#/deep/x')
  expect(shortenChildTag('#p/plan-b', '#p/0/0/0/0')).toBe('#p/plan-b')

  const marks = renderChildMarks('item1', '#map', ['#Map/1', '#Map/Tech', '#Map/a\\b'])
  expect(marks).toContain('class="child-tag"')
  expect(marks).toContain('title="#Map/1"')
  expect(marks).toContain('>1</mark>')
  expect(marks).toContain('title="#Map/Tech"')
  expect(marks).toContain('>Tech</mark>')
  // backslash in label stays validly escaped inside the JS string literal in onmousedown
  expect(marks).toContain('a\\\\b')

  const bare = '<p><mark class="label unique" title="#map">map</mark></p>'
  expect(insertInlineChildTags(bare, '<mark class="child-tag">a</mark>')).toBe(
    '<p><mark class="label unique" title="#map">map</mark> <span class="child-tags"><mark class="child-tag">a</mark></span></p>',
  )
  // stray <br> before <style> is dropped so children stay on one line, while <style> and comments survive
  const withStyle = '<p><mark class="label unique" title="#map">map</mark><br><!-- <br> --><style>#x{}</style></p>'
  expect(insertInlineChildTags(withStyle, '<mark class="child-tag">a</mark>')).toBe(
    '<p><mark class="label unique" title="#map">map</mark> <span class="child-tags"><mark class="child-tag">a</mark></span><!-- <br> --><style>#x{}</style></p>',
  )
})

test('a label keeps its own boundary where lowercasing lengthens it (labelTextOf, shortenChildTag)', () => {
  // as the route reads an item: the label is the first tag of the WHOLE lowercased line (a capital
  // sigma lowercases by what follows it there), labelText the line's slice of the label's length
  const read = (line: string) => {
    const label: string = parseTags(line.toLowerCase()).raw[0]
    return { label, labelText: line.slice(0, label.length) }
  }
  // the titles and texts of the marks a parent draws for children with these first lines
  const drawn = (parent: string, ...lines: string[]) => {
    const children = lines.map(line => (({ label, labelText }) => labelTextOf(labelText, label))(read(line)))
    const marks = renderChildMarks('item1', read(parent).label, children.join(' ').split(' ').filter(Boolean))
    return [...marks.matchAll(/title="([^"]*)"[^>]*>([^<]*)<\/mark>/g)].map(m => [m[1], m[2]])
  }
  expect(read('#İstanbul/İzmir travel'), 'the app\'s labelText runs past such a label (the quirk this works around)').toEqual({ label: '#i̇stanbul/i̇zmir', labelText: '#İstanbul/İzmir t' })
  expect(drawn('#İstanbul', '#İstanbul/İzmir travel'), 'the next word stays out of the child').toEqual([['#İstanbul/İzmir', 'İzmir']])
  expect(drawn('#p', '#p/İzmir: museums'), 'a colon stays out of the child').toEqual([['#p/İzmir', 'İzmir']])
  expect(drawn('#p', '#p/İİİİΣ:a b'), 'a capital sigma before a delimiter and a letter: one mark').toEqual([['#p/İİİİΣ', 'İİİİΣ']])
  expect(drawn('#İstanbul', '#İstanbul/ΟΣ.A'), 'a period stays out of the child').toEqual([['#İstanbul/ΟΣ', 'ΟΣ']])
  expect(drawn('#İstanbul/İzmir x', '#İstanbul/İzmir/park'), 'a deeper child keeps its first letter').toEqual([['#İstanbul/İzmir/park', 'park']])
  expect(drawn('#Map', '#Map/Tech notes', '#Map/1'), 'ordinary labels are the slices they always were').toEqual([['#Map/Tech', 'Tech'], ['#Map/1', '1']])
  expect(labelTextOf('#Map', '#map'), 'a header that is its label').toBe('#Map')
  expect(labelTextOf('plain text', ''), 'no label, no text').toBe('')
  expect(shortenChildTag('#İstanbul/İzmir', '#İstanbul'.toLowerCase()), 'a direct child is cut at its own slash').toBe('#/İzmir')
  expect(shortenChildTag('#İstanbul/plan', '#İstanbul/İzmir'.toLowerCase()), 'a sibling under the same parent').toBe('#/plan')
})
