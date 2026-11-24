import { expect, test } from '@playwright/test'
import { Marked } from 'marked'

import {
  DEFAULT_INSTALL_OWNER,
  DEFAULT_INSTALL_REPO,
  confirmCommandContent,
  literalCode,
  literalText,
  oneTapCommand,
  type InstalledItemInfo,
} from '../../src/command_links.js'
import { grammarRefs } from '../../src/inert_markdown.js'
// @ts-expect-error util.js is plain js without a declaration file
import { escapedUrlChar, escapedUrlEntity } from '../../src/util.js'
// @ts-expect-error vendored marked-extended-tables is plain js without a declaration file
import markedExtendedTables from '../../src/vendor/marked-extended-tables.js'
import { wikiLinkExtension } from '../../src/wiki_links.js'

// Mirror Modal.svelte's `replaceNakedURLs(marked.parse(content, { breaks: true }))` pipeline,
// including global `marked`'s extended-tables and wiki-links extensions from src/client-globals.ts.
function renderModalHtml(content: string): string {
  const m = new Marked({ gfm: true, breaks: true })
  m.use(markedExtendedTables())
  m.use({
    extensions: [wikiLinkExtension(() => ({ url: 'vscode://olcan.auto-open-obsidian/link/{link}' }))],
  })
  const html = m.parse(content, { breaks: true }) as string
  const urlRegex = new RegExp(`(^|.?)(https?:\\/\\/${escapedUrlChar('[^\\s)<"]')}*)`, 'g')
  const entityEnd = new RegExp(`${escapedUrlEntity}$`)
  return html.replace(urlRegex, (match, pfx, url) => {
    if (pfx.match(/[="'`:]$/)) return match
    const sfx = entityEnd.test(url) ? '' : (url.match(/(?:[.,;:]|:\d+:\d+)$/)?.pop() ?? '')
    if (sfx) url = url.slice(0, -sfx.length)
    try {
      new URL(url)
      return `${pfx}<a href="${url}" target="_blank">${url}</a>${sfx}`
    } catch {
      return pfx + url + sfx
    }
  })
}

const decodeRefs = (s: string) => s.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(+d))

const installed = (
  label: string,
  path: string,
  owner = DEFAULT_INSTALL_OWNER,
  repo = DEFAULT_INSTALL_REPO,
  branch = 'master',
  shared: unknown = null,
): InstalledItemInfo => ({ label, shared, attr: { owner, repo, path, branch, shared } })

const items: InstalledItemInfo[] = [
  installed('#key_buttons', 'key_buttons.md'),
  installed('#util/core', 'util/core.md'),
  installed('#custom_note', 'custom.markdown'),
  installed('#y', 'x.md'),
  { label: '#x', attr: null },
  { label: '#local_note', attr: null },
  installed('#shared_item', 'shared_item.md', DEFAULT_INSTALL_OWNER, DEFAULT_INSTALL_REPO, 'master', {
    keys: ['pub'],
  }),
  installed('#dollar$tag', 'dollar.md'),
  installed('#foreign', 'foreign.md', 'other_owner', DEFAULT_INSTALL_REPO),
  installed('#other_repo_item', 'other_repo_item.md', DEFAULT_INSTALL_OWNER, 'other.items'),
  installed('#dup_path_a', 'dup.md'),
  installed('#dup_path_b', 'dup.md'),
  installed('#dup_label', 'dup_label_1.md'),
  installed('#dup_label', 'dup_label_2.md'),
  installed('#mixed_dup', 'mixed_dup.md'),
  { label: '#mixed_dup', attr: null },
]

test('one-tap command rule: returns the label-bound /_update only for one unshared default-repo item (master/no branch everywhere; preview only with preview: true)', () => {
  // allowed on EVERY account (no branch or `master`): same bound command with and without `preview: true`
  const allowedEverywhere: [string, string][] = [
    ['/_update key_buttons mind.items master', '/_update #key_buttons mind.items master'],
    ['/_update key_buttons', '/_update #key_buttons'],
    ['/_update key_buttons.md', '/_update #key_buttons'],
    ['/_update #key_buttons', '/_update #key_buttons'],
    ['/_update #key_buttons mind.items', '/_update #key_buttons mind.items'],
    ['/_update #key_buttons mind.items master', '/_update #key_buttons mind.items master'],
    ['/_update key_buttons mind.items', '/_update #key_buttons mind.items'],
    ['/_update util/core', '/_update #util/core'],
    ['/_update custom.markdown', '/_update #custom_note'],
    ['/_update #custom_note', '/_update #custom_note'],
    // item at x.md labelled #y while a plain note is labelled #x: binds to #y so dispatcher checks label
    ['/_update x', '/_update #y'],
  ]
  for (const [cmd, expected] of allowedEverywhere) {
    expect(oneTapCommand(cmd, items), `one-tap bound command (default) for ${cmd}`).toBe(expected)
    expect(oneTapCommand(cmd, items, { preview: false }), `one-tap bound command (preview: false) for ${cmd}`).toBe(
      expected,
    )
    expect(oneTapCommand(cmd, items, { preview: true }), `one-tap bound command (preview: true) for ${cmd}`).toBe(
      expected,
    )
  }

  // `preview` branch: one tap ONLY with `{ preview: true }` (publisher's own notebook), null otherwise
  const allowedPreviewOnly: [string, string][] = [
    ['/_update key_buttons mind.items preview', '/_update #key_buttons mind.items preview'],
    ['/_update #key_buttons mind.items preview', '/_update #key_buttons mind.items preview'],
    ['/_update util/core mind.items preview', '/_update #util/core mind.items preview'],
    ['/_update #util/core mind.items preview', '/_update #util/core mind.items preview'],
    ['/_update x.md mind.items preview', '/_update #y mind.items preview'],
  ]
  for (const [cmd, expected] of allowedPreviewOnly) {
    expect(oneTapCommand(cmd, items), `preview branch without preview option is null: ${cmd}`).toBeNull()
    expect(oneTapCommand(cmd, items, { preview: false }), `preview branch with preview: false is null: ${cmd}`).toBeNull()
    expect(oneTapCommand(cmd, items, { preview: true }), `preview branch with preview: true for ${cmd}`).toBe(expected)
  }

  // refused commands, each with its reason
  const refused: [string, string][] = [
    [
      '/_update key_buttons mind.items 0123456789abcdef0123456789abcdef01234567',
      '40-hex commit id branch is never one tap',
    ],
    ['/_update key_buttons mind.items 0123456', '7-hex commit id branch is never one tap'],
    ['/_update key_buttons mind.items feat/x', 'branch outside ONE_TAP_BRANCHES is never one tap'],
    ['/_update shared_item', 'shared installed item by path is never one tap'],
    ['/_update #shared_item', 'shared installed item by label is never one tap'],
    ['/_update dollar', 'installed item whose label holds $ is never one tap'],
    ['/_update #dollar$tag', 'label holding $ is never one tap'],
    ['/_update key_buttons other.items', 'another repository is not one tap'],
    ['/_update key_buttons other.items preview', 'another repository with branch is not one tap'],
    ['/_update key_buttons mind.items preview attacker', 'owner argument is never one tap'],
    ['/_update key_buttons mind.items preview olcan', 'explicit default owner argument is never one tap'],
    ['/_update key_buttons mind.items preview olcan ghp_secret', 'token argument is never one tap'],
    ['/_update key_buttons <- #dep', '<- suffix is never one tap'],
    ['/_update key_buttons mind.items preview <- #dep', '<- suffix after branch is never one tap'],
    ['/_update local_note', 'existing non-installed item by path is not one tap'],
    ['/_update #local_note', 'existing non-installed item by #label is not one tap'],
    ['/_update foreign', 'item installed from another owner by path is not one tap'],
    ['/_update #foreign', 'item installed from another owner by #label is not one tap'],
    ['/_update other_repo_item', 'item installed from another repo by path is not one tap'],
    ['/_update #other_repo_item', 'item installed from another repo by #label is not one tap'],
    ['/_update dup', 'path matching two installed items is not one tap'],
    ['/_update #dup_label', 'label matching two installed items is not one tap'],
    ['/_update mixed_dup', 'installed item sharing label with another item is not one tap'],
    ['/_update #mixed_dup', 'duplicate label (one installed, one manual) is not one tap'],
    ['/_update no_such_item', 'missing item by path is not one tap'],
    ['/_update #no_such_item', 'missing item by #label is not one tap'],
    ['/_install key_buttons', '/_install is never one tap'],
    ['/_install key_buttons mind.items preview', '/_install with repo/branch is never one tap'],
    ['/_update', 'bare /_update without path is not one tap'],
    ['/_invert', 'other built-in command is not one tap'],
    ['/_zoom 1.05', 'other built-in command with args is not one tap'],
    ['/_rename #a #b', 'destructive built-in command is not one tap'],
    ['/push key_buttons', 'item command is not one tap'],
  ]
  for (const [cmd, reason] of refused) {
    expect(oneTapCommand(cmd, items), `${reason} (default): ${cmd}`).toBeNull()
    expect(oneTapCommand(cmd, items, { preview: true }), `${reason} (preview: true): ${cmd}`).toBeNull()
  }

  // dispatcher-differential safe-side cases
  for (const [cmd, reason] of [
    ['/_UPDATE key_buttons', 'command case mismatch'],
    ['/_update Key_Buttons', 'path case mismatch'],
    ['/_update #Key_Buttons', 'label case mismatch'],
    ['/_update key_buttons Mind.Items', 'repo case mismatch'],
    ['/_update key_buttons mind.items PREVIEW', 'branch case mismatch'],
    ['/_update  key_buttons', 'extra internal space'],
    ['/_update key_buttons ', 'trailing space'],
    [' /_update key_buttons', 'leading space'],
    ['/_update /key_buttons', 'leading slash in path'],
    ['/_update /#key_buttons', 'leading slash before #label'],
    ['/_update key_buttons.txt', 'invalid extension'],
    ['/_update key_buttons\tmind.items', 'tab whitespace'],
    ['/_update key_buttons\nmind.items', 'newline'],
  ] as [string, string][])
    expect(oneTapCommand(cmd, items), `safe side (${reason}): ${cmd}`).toBeNull()

  // shared checks independently: live item.shared alone (before attr flush) and attr.shared alone
  expect(
    oneTapCommand('/_update live_shared', [
      {
        label: '#live_shared',
        shared: { keys: ['k'] },
        attr: {
          owner: DEFAULT_INSTALL_OWNER,
          repo: DEFAULT_INSTALL_REPO,
          path: 'live_shared.md',
          branch: 'master',
          shared: null,
        },
      },
    ]),
    'live item.shared set before attr flush is not one tap',
  ).toBeNull()
  expect(
    oneTapCommand('/_update attr_shared', [
      {
        label: '#attr_shared',
        shared: null,
        attr: {
          owner: DEFAULT_INSTALL_OWNER,
          repo: DEFAULT_INSTALL_REPO,
          path: 'attr_shared.md',
          branch: 'master',
          shared: { keys: ['k'] },
        },
      },
    ]),
    'persisted attr.shared set without live item.shared is not one tap',
  ).toBeNull()
  expect(
    oneTapCommand('/_update nobranch', [
      { label: '#nobranch', attr: { owner: DEFAULT_INSTALL_OWNER, repo: DEFAULT_INSTALL_REPO, path: 'nobranch.md' } },
    ]),
    'missing attr.branch is not one tap',
  ).toBeNull()
  expect(
    oneTapCommand('/_update nolabel', [
      { label: '', attr: { owner: DEFAULT_INSTALL_OWNER, repo: DEFAULT_INSTALL_REPO, path: 'nolabel.md', branch: 'master' } },
    ]),
    'unlabeled item is not one tap',
  ).toBeNull()
})

test('literalCode, literalText, and confirmation dialog content: hostile text reaches _modal encoded and renders as plain literal text only', () => {
  expect(literalCode(''), 'literalCode empty text yields empty string').toBe('')
  expect(literalCode('**bold** <em>x</em>')).toBe('<code>' + grammarRefs('**bold** <em>x</em>') + '</code>')
  expect(literalText(''), 'literalText empty text yields empty string').toBe('')

  const hostiles = [
    '/_cmd `backticks` ``double``',
    '/_cmd ![tracker](https://evil.example/px.png)',
    '/_cmd [click](https://evil.example)',
    '/_cmd <img src=x onerror=alert(1)> </code><script>alert(1)</script>',
    '/wiki_links https://evil.example/naked?a=1&b=2',
    '/_cmd [[AGENTS.md]] $`x^2`$ **bold** _em_ ~~del~~',
    '/_cmd &lt;b&gt; &#60;script&#62; | a | b |',
  ]
  for (const cmd of hostiles) {
    const content = confirmCommandContent(cmd)
    const rendered = renderModalHtml(content)
    expect(rendered, `no anchor, image, or script tag in ${rendered}`).not.toMatch(/<(?:a|img|script|strong|em|del|table)\b/i)
    const match = /^<p>Run this command\?<\/p>\n<p><code>([A-Za-z0-9 &#;]*)<\/code><\/p>\n$/.exec(rendered)
    expect(match, `hostile command rendered with extra markup: ${rendered}`).not.toBeNull()
    expect(decodeRefs(match![1]), `decoded dialog text matches exact command for ${cmd}`).toBe(cmd)
    expect(content, `exact modal content for ${cmd}`).toBe('Run this command?\n\n' + literalCode(cmd))
  }

  // literalText: multi-line hostile text (emphasis, link, image, html, table, wiki link, naked URL,
  // 4-space indent, two lines) renders in dialog font (no `code`/`pre`) with `<br>` keeping lines apart
  const multiLine = [
    '**bold** _em_ [click](https://evil.example) ![px](https://evil.example/p.png) <img src=x onerror=alert(1)>',
    '    | a | b | [[AGENTS.md]] https://evil.example/u?a=1&b=2',
  ].join('\n')
  const renderedMulti = renderModalHtml(literalText(multiLine))
  expect(renderedMulti, 'literalText produces no formatting, link, image, code, or table markup').not.toMatch(
    /<(?:a|img|script|strong|em|del|table|pre|code|h[1-6]|ul|ol|blockquote|hr)\b/i,
  )
  const multiMatch = /^<p>([A-Za-z0-9 &#;]*)<br>([A-Za-z0-9 &#;]*)<\/p>\n$/.exec(renderedMulti)
  expect(multiMatch, `literalText kept two lines apart via <br> with no extra tags: ${renderedMulti}`).not.toBeNull()
  expect([decodeRefs(multiMatch![1]), decodeRefs(multiMatch![2])], 'literalText decoded lines match input').toEqual(
    multiLine.split('\n'),
  )
  expect(renderModalHtml(literalText('line1\r\nline2')), 'literalText normalizes CRLF into <br>').toBe(
    '<p>line1<br>line2</p>\n',
  )
})
