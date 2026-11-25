// what a click on an item's number asks for (index.svelte's onItemTouch; the owner, 2026-11-18), kept pure
// so its table runs without a browser (tests/unit/number_click.spec.ts).
//
// The number is green when the item matches the query (`matching`: the value Item.svelte's `matching` class
// on the button is rendered from, set per item by onEditorChange), and that state alone says what a plain
// click does:
// - `touch`: a green number moves its item: its time is set to now and saved, as every plain click did
//   before (the item goes up as far as its time takes it: the ranking reads its other criteria first, so a
//   green item can stay where it is). Green: the item whose label or id the query names, every item of a
//   tag's view, the results of a search;
// - `select`: a plain number selects its item (index.svelte's selectItem: the query becomes the item's
//   select name, below, in a history entry of its own, and the page scrolls to the item; no save is asked
//   for). With no query every number is plain. Shift+click selects whatever the number shows;
// - `down`, `up`, `back`: Option, Cmd and Option+Cmd keep their jobs whatever the number shows, with or
//   without Shift (one place down, one place up, a day back in time: thirty with Shift, which onItemTouch
//   reads off the event).
// A call without an event is no click: a run's touch (onItemRun), which moves the item up as before.
// Ctrl is not read, as before (on a Mac a Ctrl+click is the context menu's, and no click).
export type NumberClick = 'select' | 'touch' | 'down' | 'up' | 'back'
export type ClickModifiers = { altKey?: boolean; metaKey?: boolean; shiftKey?: boolean }

export function numberClick(e: ClickModifiers | null | undefined, matching: boolean): NumberClick {
  if (!e) return 'touch'
  if (e.altKey && e.metaKey) return 'back'
  if (e.altKey) return 'down'
  if (e.metaKey) return 'up'
  return e.shiftKey || !matching ? 'select' : 'touch'
}

// THE NAME A SELECT GIVES AN ITEM (index.svelte's selectItem): what the query becomes.
// - An item with a unique label is selected by the label: under it the app lists the item's children and
//   its keyboard navigation works, which an id reference never gives.
// - Any other item by its id reference, in the form that outlives the tab: `id:<saved id>`, the id of its
//   document, as soon as the creation is acknowledged (`savedId`; the copy shortcut names an item the same
//   way). Until then a select names the item by the tab's own id (`id`), for this tab only: its address and
//   history entry name nothing after a reload or in another tab, and a slow or an offline write keeps that
//   window open as long as it lasts. At the acknowledgement, index.svelte's onEditorDone updates the CURRENT
//   history entry to `id:<saved id>` when the creation wrote `id:<id>` into the box (`createdBoxId`) and the
//   box holds that exact text then — including a later entry written meanwhile by a fresh select of the same
//   item (the creation's own earlier entry then keeps the tab's id); any other entry written before the
//   acknowledgement (not current then, or for a creation that did not place `id:<id>` in the box) stays as
//   written. (A limit left as it is, not a necessity: the creation reserves its document's id before the
//   write; naming an item by it before the acknowledgement would be a navigation decision of its own.) For an
//   item the tab loaded, the two ids are one.
export type Selectable = { id: string; savedId?: string | null; labelUnique?: boolean; labelText?: string | null }
const labeled = (item: Selectable): boolean => !!item.labelUnique && !!item.labelText
export const selectName = (item: Selectable): string =>
  labeled(item) ? item.labelText! : 'id:' + (item.savedId || item.id)

// whether a query IS the selection of an item already: exactly the name a select gives it or, for an item
// selected by an id reference, its other id's spelling (either spelling targets the same item; the lists
// under them can still differ, since another item whose text holds the literal saved-id reference matches
// that spelling alone, and an id typed in another case targets the item in the search while an exact lookup
// of it fails), trimmed and without case, as the app reads a query. Nothing else is the same
// selection: a labeled item's id reference is another view (no children listed under it, no keyboard
// navigation), and a query with more terms is another list. (Whether that query is the view SHOWN is the
// caller's to say: a name typed into the box is the query before it is applied)
export function selectsAlready(query: string, item: Selectable): boolean {
  const text = query.trim().toLowerCase()
  if (text == selectName(item).toLowerCase()) return true
  return !labeled(item) && text == ('id:' + item.id).toLowerCase()
}
