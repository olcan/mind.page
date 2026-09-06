// Console diagnostics for items shown with the red ERROR border (Item.svelte `class:error`).
// The border is decided by ONE dom inspection after rendering: any `.console-error`,
// `.macro-error`, `mark.missing` or generic `.error` element (plus the separate
// `failedTests` flag, which has its own deduped diagnostic: index.svelte `logFailedTests`,
// review 192). Two of those sources were silent in the console: a macro whose evaluation
// throws `eval missing dependencies` (Item.svelte deliberately skips the console.error, since
// a DIRECT missing dependency is marked visibly -- a TRANSITIVE one, a dependency's missing
// dependency, is not), and missing tags (a visible mark, easy to miss). This module reads
// the rendered causes at that same inspection seam and logs one console.error per item when
// its reasons CHANGE, forgetting the item when it recovers so a recurrence logs again.

export type ItemErrorSources = {
  // distinct macro error messages (`.macro-error` titles), render order; '' for a macro error
  // without a message
  macroErrors: string[]
  // distinct missing tags by their RESOLVED identity (the mark's `title`, the absolute tag; the
  // displayed text is a shortened tag or a link caption), render order; `hidden` when ANY
  // occurrence is a hidden tag, i.e. a dependency
  missingTags: { tag: string; hidden: boolean }[]
  // rendered `.console-error` indicators: a log block's ERROR line renders one in the content
  // and one in the log summary, and ERROR: prose outside blocks renders one too
  consoleErrorIndicators: number
  // other `.error` elements (item-authored markup) that are none of the sources above
  genericErrors: number
}

// the minimal dom surface the collector needs (the real element, or a test stand-in)
export type ErrorRoot = { querySelectorAll(selector: string): Iterable<ErrorElement> }
export type ErrorElement = {
  getAttribute(name: string): string | null
  textContent: string | null
  classList: { contains(name: string): boolean }
  matches(selector: string): boolean
}

const KNOWN_SOURCES = ['.macro-error', '.console-error', 'mark.missing']

// the rendered causes under `root` (the item's rendered element)
export function collectItemErrorSources(root: ErrorRoot): ItemErrorSources {
  const all = (selector: string) => Array.from(root.querySelectorAll(selector))
  const macroErrors = [...new Set(all('.macro-error').map(e => (e.getAttribute('title') ?? '').trim()))]
  const missing = new Map<string, boolean>()
  for (const mark of all('mark.missing')) {
    const tag = (mark.getAttribute('title') ?? '').trim() || (mark.textContent ?? '').trim()
    if (!tag) continue
    missing.set(tag, (missing.get(tag) ?? false) || mark.classList.contains('hidden'))
  }
  const missingTags = [...missing].map(([tag, hidden]) => ({ tag, hidden }))
  const consoleErrorIndicators = all('.console-error').length
  const genericErrors = all('.error').filter(e => !KNOWN_SOURCES.some(s => e.matches(s))).length
  return { macroErrors, missingTags, consoleErrorIndicators, genericErrors }
}

const MISSING_DEPENDENCY_HINT =
  ' (ensure each named dependency has one uniquely labelled item: install or restore missing' +
  ' items, or resolve duplicate labels; dependencies can be transitive)'

// the human-readable reasons behind the border, in a fixed order (empty: no error source)
export function describeItemErrors(sources: ItemErrorSources): string[] {
  const reasons: string[] = []
  for (const message of sources.macroErrors) {
    if (!message) {
      reasons.push('macro error without a message (the failing macro is outlined in the content)')
      continue
    }
    const hint = message.startsWith('eval missing dependencies') ? MISSING_DEPENDENCY_HINT : ''
    reasons.push(`macro error: ${message}${hint}`)
  }
  const hidden = sources.missingTags.filter(t => t.hidden).map(t => t.tag)
  const visible = sources.missingTags.filter(t => !t.hidden).map(t => t.tag)
  if (hidden.length) {
    reasons.push(
      `${hidden.length} missing hidden tag${hidden.length > 1 ? 's' : ''}: ${hidden.join(' ')}` +
        ' (a hidden tag is a dependency and needs one uniquely labelled item)'
    )
  }
  if (visible.length) {
    reasons.push(
      `${visible.length} missing tag${visible.length > 1 ? 's' : ''}: ${visible.join(' ')}` +
        ' (no other item carries the tag: add it to an item or remove it)'
    )
  }
  const indicators = sources.consoleErrorIndicators
  if (indicators > 0) {
    reasons.push(
      `${indicators} rendered console-error indicator${indicators > 1 ? 's' : ''}` +
        ' (ERROR lines in log blocks, each also summarized, or ERROR: prose)'
    )
  }
  if (sources.genericErrors > 0) {
    reasons.push(
      `${sources.genericErrors} element${sources.genericErrors > 1 ? 's' : ''} with the error class in the` +
        ' rendered content'
    )
  }
  return reasons
}

// a deduped logger: `(id, name, sources)` logs one console.error per item when the reasons
// change, and forgets the item once it has no reasons (so a recurrence logs again)
export function makeItemErrorLogger(log: (message: string) => void = m => console.error(m)) {
  const logged = new Map<string, string>()
  return (id: string, name: string, sources: ItemErrorSources): void => {
    const reasons = describeItemErrors(sources)
    if (!reasons.length) {
      logged.delete(id)
      return
    }
    const fingerprint = JSON.stringify(reasons)
    if (logged.get(id) == fingerprint) return
    logged.set(id, fingerprint)
    log(`[${name}] error indication due to: ${reasons.join('; ')}`)
  }
}

// the app's one logger (module-level: the memo must survive component re-creation)
export const logItemErrors = makeItemErrorLogger()
