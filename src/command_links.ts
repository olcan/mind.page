// One-tap policy and safe literal dialog content for inert-section command links and dispatcher
// messages (the owner, 2026-11-23, option B): only updating one already-installed, unshared item
// from `olcan/mind.items` (`master` or no branch on every account; `preview` only when the caller
// opts in on the publisher's own notebook) runs at a single tap, dispatched by the item's label.
// Every other command link asks "Run this command?" through `literalCode`, and dispatcher alerts
// and install progress text pass through `literalText` (`grammarRefs`: letters, digits, and ASCII
// spaces stay as they are, everything else becomes a decimal character reference).

import { grammarRefs } from './inert_markdown.js'
// @ts-ignore untyped util.js (same as src/inert.ts and src/inert_markdown.ts)
import { tagRegex } from './util.js'

// the app's own default install/update repository (imported by index.svelte's onEditorDone so
// these literals live once)
export const DEFAULT_INSTALL_OWNER = 'olcan'
export const DEFAULT_INSTALL_REPO = 'mind.items'

// the branch names one tap may carry. The dispatcher hands the branch to GitHub as a REVISION
// (listCommits `sha`), which also takes a commit id, and a commit of ANY fork is served through
// its parent repository: only a fixed name is known to resolve in the default repository itself.
// `master` (or no branch) is one tap on every account; `preview` requires `{ preview: true }`
const ONE_TAP_BRANCHES: readonly string[] = ['master', 'preview']

export interface InstalledItemInfo {
  label?: string | null
  shared?: unknown
  attr?: {
    owner?: unknown
    repo?: unknown
    path?: unknown
    branch?: unknown
    shared?: unknown
  } | null
}

// plain path segments: ASCII word characters plus internal `.` / `-`, separated by single `/`,
// no leading/trailing `/` or `.`, no `..`, and no characters that `onEditorDone` escapes or splits
const SAFE_SEGMENTS = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/
const isSafeSegments = (s: string) => SAFE_SEGMENTS.test(s) && !s.includes('..') && !s.endsWith('.')

// matches onEditorDone's extension normalization (`!path.includes('.') -> + '.md'`, else `.md` or
// `.markdown`), while rejecting leading slashes (`/` or `//`) on the safe side
function normalizeInstallPath(raw: string): string | null {
  if (!isSafeSegments(raw)) return null
  if (!raw.includes('.')) return raw + '.md'
  if (raw.endsWith('.md') || raw.endsWith('.markdown')) return raw
  return null
}

function isDefaultInstalled(item: InstalledItemInfo): boolean {
  // Check both live `item.shared` and persisted `item.attr?.shared`: `item.share()` sets the live
  // flag immediately while `attr.shared` flushes asynchronously (and `/_update` copies `item.shared`).
  return (
    item.shared == null &&
    item.attr?.shared == null &&
    item.attr?.owner === DEFAULT_INSTALL_OWNER &&
    item.attr?.repo === DEFAULT_INSTALL_REPO &&
    typeof item.attr?.path === 'string' &&
    normalizeInstallPath(item.attr.path) !== null &&
    typeof item.attr?.branch === 'string' &&
    item.attr.branch.length > 0
  )
}

// the command a one-tap link dispatches, or null when the link asks first (when in doubt: null).
// Only `/_update` of ONE item the page holds, installed from the default owner and repository
// and not shared, optionally naming that repository and `master` (or `preview` when `preview: true`
// is passed, on the publisher's own notebook). What is returned is the update BY THE LABEL OF THE
// ITEM IT NAMES AT THE TAP, whatever form the link has (the form the item's own update control
// dispatches, onItemUpdate): the dispatcher then reads the path from that item and refuses a
// fetched file that carries another label. The dispatcher looks that label up again after its
// async waits, so a rename or deletion during the update is the dispatcher's own race, as for
// every caller
export function oneTapCommand(
  cmd: string,
  items: readonly InstalledItemInfo[],
  { preview = false }: { preview?: boolean } = {},
): string | null {
  if (!cmd || !/^[\x20-\x7e]+$/.test(cmd)) return null
  if (cmd.includes('<-') || /[`\\$]/.test(cmd)) return null
  const parts = cmd.split(' ')
  if (parts.some(p => !p)) return null
  if (parts[0] !== '/_update') return null
  if (parts.length < 2 || parts.length > 4) return null
  const [rawPath, repo, branch] = parts.slice(1)
  if (repo !== undefined && repo !== DEFAULT_INSTALL_REPO) return null
  const allowedBranches = preview ? ONE_TAP_BRANCHES : ['master']
  if (branch !== undefined && !allowedBranches.includes(branch)) return null

  let matches: InstalledItemInfo[]
  if (rawPath.startsWith('#')) {
    matches = items.filter(item => item.label === rawPath)
  } else {
    const path = normalizeInstallPath(rawPath)
    if (!path) return null
    matches = items.filter(item => item.attr?.path === path)
  }
  if (matches.length !== 1 || !isDefaultInstalled(matches[0])) return null
  const label = matches[0].label ?? ''
  // the label goes into a command: a plain lowercase tag, unique on the page
  if (label !== label.toLowerCase() || !tagRegex.test(label) || /[`\\$]/.test(label)) return null
  if (items.filter(item => (item.label ?? '').toLowerCase() === label).length !== 1) return null
  return ['/_update', label, ...parts.slice(2)].join(' ')
}

// encodes arbitrary text inside `<code>...</code>` via `grammarRefs` (letters, digits, and ASCII
// spaces stay as they are; everything else becomes a decimal character reference), so Modal.svelte's
// `marked.parse` (with extended tables and wiki links) and `replaceNakedURLs` render it literally
export function literalCode(text: string): string {
  return text ? '<code>' + grammarRefs(text) + '</code>' : ''
}

// encodes arbitrary (possibly multi-line) text for Modal.svelte's dialog font via `grammarRefs`
// (letters, digits, and ASCII spaces stay as they are; everything else becomes a decimal character
// reference). Leading spaces on a line are also encoded as `&#32;` so 4-space lines never become
// indented code blocks, and lines are joined with raw `\n` so `marked.parse(..., { breaks: true })`
// emits `<br>` line breaks (a `&#10;` reference collapses to a space inside HTML `<p>`)
export function literalText(text: string): string {
  if (!text) return ''
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => grammarRefs(line).replace(/^ +/, s => '&#32;'.repeat(s.length)))
    .join('\n')
}

// confirmation modal markdown for a command link that is not one-tap
export function confirmCommandContent(cmd: string): string {
  return 'Run this command?\n\n' + literalCode(cmd)
}
