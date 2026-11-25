// THE UNSAVED ITEMS, BY NAME, where a reload would lose them (index.svelte: the app's own reload
// question, reloadOnRequest, and the dialog it shows after the browser's own "changes may not be
// saved" box was cancelled, onBeforeUnload; the owner, 2026-11-23: "Can the reload prompt be a
// modal that lists items?", and 2026-11-25: "let's just show the list right after cancellation of
// reload, not worth complicating it with handling all reload cases"). Kept pure so its table runs
// without a browser (tests/unit/unsaved_list.spec.ts).
//
// An item's name is its label where it has one of its own, else the first words of its text with
// the reference that finds it. Both are text
// of the account (the owner's own, or text that came in from elsewhere) and go into the app's
// dialog, which reads its content as Markdown and then makes links of addresses (Modal.svelte):
// here a name is shown as its characters and as nothing else. The list is ONE line of markup (a
// block of markup that Markdown leaves alone up to its first empty line), every name escaped and
// kept on one line, the colon of an address written as an entity so that no link is made of it.

// what would be lost of an item: text typed into its open editor (`editing`), a save that is not
// finished (`saving`), or a text that differs from the saved one with neither (`unsaved`)
export type UnsavedState = 'editing' | 'saving' | 'unsaved'
export type UnsavedEntry = { name: string; state: UnsavedState }

export const UNSAVED_NAME_MAX = 60 // characters of an item's first line that stand for its name
export const UNSAVED_LIST_MAX = 12 // items listed by name; the rest are counted

const STATE_WORDS: Record<UnsavedState, string> = { editing: 'being edited', saving: 'being saved', unsaved: 'not saved' }
const ZWSP = String.fromCharCode(0x200b) // the editor adds these to long addresses (src/zwsp.ts)

// an item's name for the list. `label`: the item's label where it is the item's OWN (no other
// item has it): that names it. Any other item, one without a label or with a label it shares (a
// log's entries all carry the log's), is named by the first line of its text that has words, cut
// at UNSAVED_NAME_MAX code points (a pair of surrogates is never split), and `ref` after it where
// one is given: the reference by which the app selects such an item (`id:` and its id, the
// route's selectName), which tells two of them apart and finds the item when typed into the box
export function unsavedName(label: string | null | undefined, text: string | null | undefined, ref: string | null | undefined = ''): string {
  const words = (s: string | null | undefined) => String(s ?? '').split(ZWSP).join('').replace(/\s+/g, ' ').trim()
  const named = words(label)
  if (named) return named
  let line = ''
  for (const raw of String(text ?? '').split('\n')) if ((line = words(raw))) break
  const chars = Array.from(line)
  const shown = !line ? 'an empty item' : chars.length > UNSAVED_NAME_MAX ? chars.slice(0, UNSAVED_NAME_MAX).join('').trimEnd() + '…' : line
  const by = words(ref)
  return by ? `${shown} (${by})` : shown
}

// a text as its characters, on one line, with no address that a link can be made of
export function unsavedText(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[&<>"'`]/g, c => `&#${c.charCodeAt(0)};`)
    .replace(/:\/\//g, '&#58;//')
}

// the list, as one line of markup: at most `max` items by name, each with what would be lost of
// it, then the count of the rest
export function unsavedListHtml(entries: UnsavedEntry[], max = UNSAVED_LIST_MAX): string {
  const shown = entries.slice(0, max)
  const rows = shown
    .map(e => `<li><span class="name">${unsavedText(e.name)}</span> <span class="state" style="opacity:0.6">(${STATE_WORDS[e.state] ?? STATE_WORDS.unsaved})</span></li>`)
    .join('')
  const more = entries.length > shown.length ? `<li class="more" style="list-style:none;opacity:0.6">and ${entries.length - shown.length} more</li>` : ''
  return `<ul class="unsaved-items" style="text-align:left;margin:10px 0 0 0;padding-left:22px;max-height:40vh;overflow-y:auto">${rows}${more}</ul>`
}

// the app's own reload question, with the list under it (the question's words are as they were)
export function reloadQuestion(entries: UnsavedEntry[]): string {
  return `Reload and discard unsaved changes?\n\n${unsavedListHtml(entries)}`
}

// what the app shows on a page that was kept after the browser's own box: the items the box was
// about, as they were when it was asked for (one of them may have been saved since)
export function unsavedNotice(entries: UnsavedEntry[]): string {
  return `When the page was about to go, ${entries.length == 1 ? 'one item' : `${entries.length} items`} had unsaved changes:\n\n${unsavedListHtml(entries)}`
}
