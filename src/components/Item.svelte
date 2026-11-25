<script context="module" lang="ts">
  // the .item-menu size per menu shape (its buttons, by class list), digit count and zoom, measured
  // on the first item that shows that shape and reused by the others: measuring it per item forced
  // a layout per render (see afterUpdate below). the menu's only per-item content is the item's
  // number, and a number of at most MENU_INDEX_DIGITS digits gets a FIXED width, that of its own
  // digits (.item-menu > .index.reserved, css below: one ch a digit, whatever the digits, in
  // whatever font is in use), so such a number sizes the menu by its digit count alone; a longer
  // number is not reserved and its item measures its own menu. (the width was 4ch at every count
  // until 2026-11-17: one size for all, and up to three digits' room kept empty beside a short
  // number, at the cost of the first line of the item's text.) cleared on a window resize and
  // when fonts finish loading (ch follows the font, so a size measured in the fallback font must
  // not be reused after the swap to the web font; spacers already inserted are not resized by
  // either, as before)
  const MENU_INDEX_DIGITS = 4
  // the number's own left padding (.index, css below: 0 4px). where the number is the menu's first
  // button the placeholder that keeps the item's text clear (afterUpdate, below) is narrower than
  // the menu by this much: the padding is no room the text has to keep out of, and with it the text
  // stood about 7px from a digit that sits mostly in the item's own padding (the owner, 2026-11-17:
  // "it is not clear that extra space is needed since the item content has its own padding");
  // about 3px remain, by the placeholder's margins. a menu that starts with another button (run)
  // keeps its full width free
  const MENU_INDEX_PAD = 4
  // the digit count of a number that gets the fixed width, 0 for a longer one
  function menuDigits(index: number) {
    const digits = String(index + 1).length
    return digits <= MENU_INDEX_DIGITS ? digits : 0
  }
  const menuSizes = new Map<string, { width: number; height: number }>()
  if (typeof window != 'undefined') {
    window.addEventListener('resize', () => menuSizes.clear())
    document.fonts?.addEventListener('loadingdone', () => menuSizes.clear())
  }
  // THE MOUSE PRESS THAT THE PAGE IS HANDLING, by the element it was made on: the target of a
  // mouse's pointerdown with its main button, noted at the window when the press begins, before
  // any handler of an item's. an item's mousedown takes it, once (onMouseDown: a state circle is
  // armed only by the mouse press that was made on that circle), since a mousedown does not say
  // what made it: a tap's compatibility mousedown comes after the finger is gone, at the element
  // the browser chose for the tap.
  // it is the record of ONE PRESS, not of the last pointer seen: the press of any other pointer
  // takes its place (a finger's and a pen's leave none), and the end or the cancelling of the
  // mouse's own press clears it. (it first held the last pointer's type, for as long as nothing
  // else pressed: a finger that was down while a mouse pressed elsewhere had its later mousedown
  // taken for the mouse's, and pushed. the review of 2026-11-19)
  let mousePress: EventTarget = null
  // what had focus at a primary press on a command link, so a tap gives it back without focusing an
  // unfocused MindBox (same single-gesture pattern as `note` in src/inert_blocks.ts)
  let commandFocus: { elem: Element; had: Element | null; over: AbortController } | null = null
  if (typeof window != 'undefined') {
    window.addEventListener('pointerdown', e => void (mousePress = e.pointerType == 'mouse' && e.button == 0 ? e.target : null), { capture: true })
    for (const type of ['pointerup', 'pointercancel'] as const)
      window.addEventListener(type, e => void (e.pointerType == 'mouse' && (mousePress = null)), { capture: true })
  }
  function menuSize(menu: Element, zoom: string, digits: number) {
    if (!digits) return { width: menu.clientWidth, height: menu.clientHeight }
    const key = zoom + '|' + digits + '|' + [...menu.children].map(c => c.className).join(',')
    let size = menuSizes.get(key)
    if (!size) menuSizes.set(key, (size = { width: menu.clientWidth, height: menu.clientHeight }))
    return size
  }
</script>

<script lang="ts">
  const _ = globalThis['_'] // imported in client.ts
  const Marked = globalThis['Marked'] // imported (and set up) in client.ts
  const markedHighlight = globalThis['markedHighlight']
  const markedExtendedTables = globalThis['markedExtendedTables']
  import {
    highlight,
    urlRegExp,
    blockRegExp,
    extractBlock,
    replaceTags,
    tagRegexExclusions,
    parseTags,
    renderTag,
    isBalanced,
    numberWithCommas,
    invalidateElemCache,
    reapRetiredElems,
    adoptCachedElem,
    skipEscaped,
    exclusionRegExp,
    skipExclusions,
    isSafeNavigationUrl,
    destroyElem,
    hash as _hash, prepareBlocks, removeSections, removeRemovedBlocks, blockExclusions } from '../util.js'
  import { wikiLinkExtension, wikiLinkRegExp } from '../wiki_links'

  import { Circle } from 'svelte-loading-spinners'
  import {
    editInertText,
    scanInert,
    INERT_FENCED_PLACEHOLDER,
    INERT_MARKER_SOURCE,
    INVALID_INERT_REGION,
    childTagRegions, chatResetOffsets, CHAT_BOUNDARY_RESET,
    resolveRelativeTag,
  } from '../inert'
  import Editor from './Editor.svelte'
  import { collectItemErrorSources, logItemErrors } from '../item_errors'
  import { renderInertMarkdown } from '../inert_markdown'
  import { insertInlineChildTags, isMarkVisible, isNameOnlyContent, renderChildMarks } from '../child_tags'
  import { forgetSelection, inertBlocks, sayExpanded } from '../inert_blocks'
  import { typesetInertMath } from '../inert_math'
  export let editable = true
  export let pushable = false
  export let previewable = false
  // failed _tests in the item's global store (computed in index.svelte updateItems,
  // where the same condition also ranks the item as an error): drives the red border
  // for a state that renders no dom/console trace of its own
  export let failedTests = false
  export let editing = false
  export let focused = false
  export let saving = false
  // a RUNNING item is marked by a small spinning circle left of its number, and left of the edit
  // menu's buttons while it is edited (the running mark, css below), and by nothing else: until
  // 2026-11-18 its border turned blue and an overlay dimmed it under a large spinner (a task
  // item, whose store carries the bridge's `_agent.state`, had the border alone). the mark is the
  // ONE thing a running item shows: its status (html, set through _Item's status, index.svelte)
  // is the mark's tooltip, and a progress fills the mark clockwise (until 2026-11-19 a line at the
  // item's bottom and a bar under it). `status` and `progress` are what the item's record holds
  // when the route's list is evaluated: for a component made anew, and after any other change of
  // the list. a change of either comes through this item's hook (itemHooks.running_mark, below),
  // not through these: the route writes them on the record without invalidating its list
  export let running = false
  export let status = ''
  export let progress: number = null
  export let admin = false
  export let fixed = false
  // hide the item label on shared pages: always for contiguous reading pages, and for the item at
  // shared index 0 (whose label already heads the page) when labels are enabled via shared.labels
  export let hideLabel = false
  export let source = null
  export let path = null
  export let hidden = false
  export let showLogs = false
  export let selectionStart = 0
  export let selectionEnd = 0
  // an Item created while editing continues the session of the Item destroyed in its place (a layout moved
  // the item to another column, or hid it and showed it again): its Editor resumes the destroyed editor's
  // textarea state (editorStates in Editor.svelte). the resume is asked for only until that session ends:
  // the next session's Editor mounts in a later flush with resume false and drops the entry the session's
  // end wrote (kept for the Item's whole life, the resume brought that entry back at a later edit of the
  // item: a discarded draft in the textarea with the model holding the saved text, a MindBox data-selection
  // caret overridden by the old range; review 1)
  let resumeEditor = editing
  $: if (!editing) resumeEditor = false
  // NOTE: required props should not have default values
  export let index: number
  export let name: string
  export let id: string
  export let label: string
  export let labelText: string
  export let labelUnique: boolean
  export let headerMinimal: boolean
  export let contextLabel: string
  export let missingTags: any
  export let danglingTags: any // the resolved relative tags no item carries (index.svelte updateMissingTags)
  export let matchingTerms: any
  export let matchingTermsSecondary: any
  export let childrenString = ''
  export let childHighlightSelected = ''
  export let childHighlightSecondary = ''
  export let matching: boolean
  export let time: number
  export let timeString: string
  export let timeOutOfOrder: boolean
  export let depsString: string
  export let styleDepsString: string
  export let dependentsString: string
  export let aboveFold: boolean
  export let leader: boolean
  export let runnable: boolean

  export let text: string
  export let editorText: string
  export let expanded: any
  export let hash: string
  export let deephash: string
  export let version: number
  export let height = 0
  const placeholder = ' '
  let error = false
  let warning = false
  export let target = false
  export let target_context = false
  let saveable = false
  // (what a save would write: the editor's draft while the item is edited, else its text. empty is as the end
  // of an edit reads it, nothing but whitespace and zero-width spaces)
  $: saveable = /[^\s\u200B]/.test(editing ? (editorText ?? '') : text) /* otherwise saving would delete, so just cancel */
  export let onEditing = (
    index: number,
    editing: boolean,
    cancelled: boolean = false,
    run: boolean = false,
    e: KeyboardEvent = null
  ) => {}
  // the parent reads the index on a focus only (a blur clears its focused item). The blur of a
  // deleted item's textarea fires while its DOM is removed, when Svelte 5 has already paused
  // (inerted) the component: reading the `index` prop then, a derived of a paused component,
  // logs Svelte's derived_inert warning, so the blur passes -1 and does not read the `index` prop
  // (the callback prop itself is still read; its parent value is stable, so that read is safe)
  export let onFocused = (index: number, focused: boolean) => {}
  export let onEdited = (index: number, text: string) => {}
  export let onEditorKeyDown = (e: KeyboardEvent) => {}
  export let onEscape = e => true // false means handled/ignore
  export let onPastedImage = (url: string, file: File, size_handler = null) => {}
  export let onRun = (index: number = -1, e: MouseEvent = null, touch_first?: boolean, own_editor: boolean = false) => {}
  export let onSave = (index: number = -1, e: MouseEvent = null) => {}
  export let onTouch = (index: number, e: MouseEvent = null) => {}
  export let onUpdate = (index: number) => {}
  export let onPush = (index: number) => {}
  export let onPreview = (index: number) => {}
  export let onResized = (id, container, trigger: string) => {}
  export let onImageRendering = (src: string): any => ({})
  export let onImageRendered = (img: HTMLImageElement) => {}
  export let onMacrosExpanded = (index: number, expanded: any) => {}
  export let onPrev = () => {}
  export let onNext = () => {}

  let showDebugString = false
  let debugString
  // NOTE: the debugString also helps get rid of the "unused property" warning
  $: debugString = `${height} ${time} ${matchingTerms} ${matchingTermsSecondary}`

  function onDone(editorText: string, e: KeyboardEvent, cancelled: boolean, run: boolean) {
    if (run && !cancelled) {
      invalidateElemCache(id)
      version++ // ensure re-render even if deephash and html are unchanged
    }
    onEditing(index, (editing = false), cancelled, run, e)
  }
  let mouseDownTime = 0
  // THE STATE CIRCLES BY THE NUMBER ARE A MOUSE'S CONTROLS (the owner, 2026-11-19: "would it make
  // sense for the pushable indicator to accept clicks (with hand icon) and actually trigger a push
  // of the item, same as the push button in the editor?"). a mouse's click on the circle of an
  // item that can be pushed pushes it, by the call of the edit menu's push button, and one on the
  // circle of an item that can be previewed previews it, by the call that a click on such an item
  // makes; on an item in both states each circle acts for itself. such a click is the circle's
  // alone: it opens no editor and is no click on the number, and its press takes no focus.
  // BY WHAT PRESSED, not by what the device is said to have: a circle is armed by the mouse press
  // that began on it (mousePress, in the module script: the mouse's own pointerdown names the
  // circle), and where the click says what made it, that must be a mouse too. a mouse acts; a
  // finger and a pen do not, on any device, nor while a mouse presses elsewhere: their press and
  // their tap at a circle are the item's, as they were. the hand and the tooltip come with a
  // mouse's pointer over the circle (onPointerOver).
  // ONLY THIS ITEM'S OWN CIRCLES: the two elements bound below, never a class name, which the
  // item's own rendered text could carry too.
  // THE WHOLE GESTURE ON ONE CIRCLE: the press arms the circle it is on, and only a click
  // delivered to that same element acts. a press on a circle is never the item's: released
  // elsewhere (the click is then their common ancestor's), or on a circle that was removed or
  // made anew meanwhile, it does nothing, neither the circle's action nor the item's (mouseDownTime
  // is kept for the item's own presses).
  // THE SECOND CLICK OF A DOUBLE CLICK ACTS ON NO CIRCLE (the owner's rule): a preview that
  // succeeds turns a previewable item into a pushable one, whose circle takes the other's place
  // under the pointer, and a push goes outward: it takes a deliberate single click.
  // TOUCH TARGETING, in short: the circles have NO LISTENER OF THEIR OWN and no :hover or :active
  // rule (these handlers are the item's, and tell a circle by the event's target), because a
  // touch browser hands a tap to the nearest element within the finger's area that takes clicks,
  // and counts an element with either among those: a tap at a circle is the number's today, 1px
  // away, and would become the circle's (the ring's lesson, onIndexClick; the probes and the
  // devices are in the vault's docs/mind_page_testing.md)
  let pushableMark: HTMLElement = null
  let previewableMark: HTMLElement = null
  let pressedMark: HTMLElement = null // the circle a mouse's single press is on, until the click that follows
  function ownStateMark(e: Event): HTMLElement | null {
    const target = e.target as HTMLElement
    return target && (target === pushableMark || target === previewableMark) ? target : null
  }
  // the hand and the tooltip of a circle are a mouse's: written on the circle when a mouse's
  // pointer comes over it, and taken away when another pointer's does (a pen that hovers).
  // `moused` is a class of this code's, not a class directive, so the stylesheet names it :global
  function onPointerOver(e: PointerEvent) {
    const mark = ownStateMark(e)
    if (!mark) return
    const mouse = e.pointerType == 'mouse'
    mark.classList.toggle('moused', mouse)
    if (mouse) mark.title = mark === pushableMark ? 'push' : 'preview'
    else mark.removeAttribute('title')
  }
  function onMouseDown(e: MouseEvent) {
    // a mouse's press on one of this item's state circles (its main button): this mousedown is
    // on a circle of the item's, and the mouse press the page noted was made on that same element.
    // the note is taken here, whatever it names: a later mousedown finds none (see above)
    const pressed = mousePress
    mousePress = null
    const own = e.button == 0 ? ownStateMark(e) : null
    const mark = own && own === pressed ? own : null
    pressedMark = mark && e.detail < 2 ? mark : null
    mouseDownTime = mark ? 0 : Date.now()
    // a text selection that stands in this item at the press: a press beside it ends it, and the
    // browser has collapsed it before the click comes, which is then no edit tap (onClick)
    selectionPressed = selectedIn(container)
    // a press on the running mark by the number, or on its note (the mark's own ::after), takes
    // no focus: the default would blur whatever has it, another item's editor or the MindBox (on a
    // phone that should close the keyboard: not yet seen on the owner's), before the click that
    // shows or takes away the note is even made.
    // (the edit menu's mark prevents it itself; here the mark has no listener of its own, see
    // onIndexClick, and this is the press's first listener above it)
    // the same for a mouse's press on a state circle, which pushes or previews with the focus
    // where it was
    if (mark || (e.target as HTMLElement).closest?.('.item-menu .running-mark')) e.preventDefault()
  }
  // whether a text selection stands in `node` (its anchor or its focus): a click there is no tap. the test of
  // the item's edit taps (onClick) and of the taps on an inert block (src/inert_blocks.ts), each of which
  // reads it at the click, with the click's target, and at the press, with its own element
  const selectedIn = (node: Node) => getSelection().type == 'Range' && (node.contains(getSelection().anchorNode) || node.contains(getSelection().focusNode))
  let selectionPressed = false // what the last press found in this item (onMouseDown), until the click that follows
  function onClick(e) {
    const ended = selectionPressed
    selectionPressed = false
    // a click on the state circle that a mouse's single press armed is the circle's alone: a
    // push, as the edit menu's push button's click, or a preview. (before the rules below: as a
    // button's, it is a click however long its press was held)
    // (where the click says what made it, as a pointer event's does, that is a mouse: a click
    // that says otherwise acts on no circle, whatever armed one)
    const pressed = pressedMark
    pressedMark = null
    const mark = ownStateMark(e)
    if (mark && mark === pressed && !(e.pointerType && e.pointerType != 'mouse')) {
      e.stopPropagation()
      e.preventDefault()
      if (mark === pushableMark) onPush(index)
      else onPreview(index)
      return
    }
    // reject click without mousedown within 250ms (can happen due to tags shifting during click)
    if (Date.now() - mouseDownTime > 250) return
    // ignore clicks on loading div
    if ((e.target as HTMLElement).closest('.loading')) return
    // ignore clicks on inputs or buttons
    if (e.target.closest('input, button')) return
    // ignore clicks inside an inert frame (a canonical reply's dead frame, src/inert.ts): its
    // text is read and selected, its links are wired, and a click on it opens no editor (the
    // owner, 2026-09-27: a stray click in a long reply kept opening the item's editor). the same
    // for the block around its frames (src/inert_blocks.ts), which has a listener of its own: a
    // click anywhere on it opens and closes the block
    if (e.target.closest('.vault-result, .inert-block')) return
    // console.debug(e.target);
    // ignore clicks on "clickable" elements
    let clickable = e.target.closest('[_clickable]')
    if (clickable && (!clickable['_clickable'] || clickable['_clickable'](e))) return true
    // ignore click when text is selected in target element, or was in the item when it was pressed
    if (ended || selectedIn(e.target)) return

    if (editing) return // already editing
    // if item is previewable, then preview instead of edit
    if (previewable) onPreview(index)
    else onEditing(index, (editing = true), false /* cancelled */, false /* run */, e)
  }

  function onRunClick(e) {
    if (!runnable) return
    if (saving || running) return
    e.stopPropagation()
    e.preventDefault()
    invalidateElemCache(id)
    version++ // ensure re-render even if deephash and html are unchanged
    onRun(index, e, undefined, editing) // (while it is edited the button is its edit menu's: a run from its own editor)
  }

  function onIndexClick(e) {
    e.stopPropagation()
    e.preventDefault()
    // a click on the running mark, the number's child, is the mark's (below). the mark has NO
    // listener of its own here: with one, a touch browser gave it every tap on the digits that a
    // finger's area reached it from (Chromium's touch adjustment prefers a clickable child to its
    // clickable parent), and the number of a running item could not be tapped on a phone
    if ((e.target as HTMLElement).closest('.running-mark')) return onRunningMarkClick(e)
    onTouch(index, e)
  }

  // THE RUNNING MARK'S TOOLTIP is the item's status as plain text, or `running` alone: the status
  // is html (item code wrote it into a line of the item until 2026-11-19), read here in the inert
  // document of a template, where nothing of it loads or runs; a <br> and the end of a block are
  // line breaks, which a tooltip shows
  function statusText(html: string) {
    const template = document.createElement('template')
    template.innerHTML = html.replace(/<br\s*\/?>|<\/(?:div|p|li|pre|h[1-6]|blockquote)>/gi, '$&\n')
    return template.content.textContent
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(line => line)
      .join('\n')
  }
  // THE MARK'S TITLE AND ITS FILL ARE WRITTEN ON THE MARK ITSELF, by the action below when a mark
  // is made (a run begins, the editor opens: each has its own element) and by this item's hook
  // when the status or the progress changes. the component KEEPS them, in a plain object outside
  // Svelte's state (`ring`: the last status and progress, and the marks mounted), so a write
  // invalidates nothing: a writer can report at every step of its work (the sampler does), and
  // neither an update of this component nor one of the route's list comes of it, so no item's
  // height is read for a title or a fraction (as the status line's setter wrote its line). what a
  // write does cost is this local work on the item's own marks: the title is made again from the
  // status, also when only the fraction changed. `filled` is a class of this code's, not a class
  // directive, so the stylesheet names it :global.
  // a progress of 0 is none: the mark turns
  const ring = { status, progress, marks: new Set<HTMLElement>() }
  function writeRunningMark(mark: HTMLElement) {
    mark.title = (ring.status && statusText(ring.status)) || 'running'
    const fill = ring.progress > 0 ? (Math.min(ring.progress, 1) * 100).toFixed(3) + '%' : null
    mark.classList.toggle('filled', !!fill)
    if (fill) mark.style.setProperty('--running-mark-fill', fill)
    else mark.style.removeProperty('--running-mark-fill')
  }
  function showOnRunningMark(status: string, progress: number) {
    if (status === ring.status && progress === ring.progress) return
    Object.assign(ring, { status, progress })
    ring.marks.forEach(writeRunningMark)
  }
  function runningMark(mark: HTMLElement) {
    ring.marks.add(mark)
    writeRunningMark(mark)
    return { destroy: () => void ring.marks.delete(mark) }
  }
  $: showOnRunningMark(status, progress) // (the record's values again, whenever the route's list is evaluated)
  // where no pointer hovers (a phone) a tooltip never shows: there a tap on the mark shows the
  // same text in a small note under the menu (css: the mark's ::after, which reads the title, so
  // it follows the status), and the next tap anywhere takes it away, that tap doing whatever else
  // it does. a click on the mark is the mark's alone on every device: it is no click on the
  // number (a select or a move of the item) and none on the item (its editor). by the number it
  // arrives through the number's handler (onIndexClick), in the editor by the mark's own
  let runningNote = false
  let noteDismissal: Event = null
  $: if (!running) runningNote = false
  function onRunningMarkClick(e: MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    if (e == noteDismissal || !matchMedia('(hover: none)').matches) return
    runningNote = true
    // (the window's capture listeners have already run for this click: the next one is the first
    // it hears. a note that went with its run's end is nothing to dismiss: that click is not taken)
    const dismiss = (e: Event) => {
      if (!runningNote) return
      runningNote = false
      noteDismissal = e
    }
    window.addEventListener('click', dismiss, { capture: true, once: true })
  }

  function onSaveClick(e) {
    if (!saveable) return
    e.stopPropagation()
    e.preventDefault()
    onEditing(index, (editing = false), false /* cancelled */, false /* run */, e)
  }

  function onCancelClick(e) {
    e.stopPropagation()
    e.preventDefault()
    onEditing(index, (editing = false), true /* cancelled */, false /* run */, e)
  }

  let editor
  function onImageClick(e) {
    e.stopPropagation()
    e.preventDefault()
    editor.insertImages()
  }

  function onSourceClick(e) {
    e.stopPropagation()
    e.preventDefault()
    // `source` is an owner-controlled item attribute handed straight to window.open: a
    // javascript: (or other active) scheme here is a user-gesture code sink that no markup
    // sanitizer ever sees, so the scheme is validated on every page
    if (!isSafeNavigationUrl(source)) {
      console.warn('refusing to open item source with unsafe url:', source)
      return
    }
    window.open(source)
  }

  function onUpdateClick(e) {
    e.stopPropagation()
    e.preventDefault()
    onUpdate(index)
  }

  function onPushClick(e) {
    e.stopPropagation()
    e.preventDefault()
    onPush(index)
  }

  function onDeleteClick(e) {
    e.stopPropagation()
    e.preventDefault()
    editorText = text = '' // indicates deletion
    onEditing(index, (editing = false), false /* cancelled */, false /* run */, e)
  }

  export let onTagClick = (id: string, tag: string, reltag: string, e: MouseEvent) => {}
  export let onCommandClick = (cmd: string, e: MouseEvent) => {}
  if (!window['_handleTagClick'])
    window['_handleTagClick'] = (id: string, tag: string, reltag: string, e: MouseEvent) => {
      tag = _.unescape(tag)
      reltag = _.unescape(reltag)
      e.stopPropagation()
      e.preventDefault() // disables handler for onmousedown, prevents change of focus, text selection, etc
      onTagClick(id, tag, reltag, e)
    }

  export let onLinkClick = (id: string, href: string, e: MouseEvent) => {}
  if (!window['_handleLinkClick'])
    window['_handleLinkClick'] = (id: string, href: string, e: MouseEvent) => {
      href = _.unescape(href)
      e.stopPropagation()
      onLinkClick(id, href, e)
    }

  export let onLogSummaryClick = (id: string) => {}
  if (!window['_handleLogSummaryClick'])
    window['_handleLogSummaryClick'] = (id: string, e: MouseEvent) => {
      e.stopPropagation()
      onLogSummaryClick(id)
    }

  if (!window['_handleDepsSummaryClick'])
    window['_handleDepsSummaryClick'] = (id: string, e: MouseEvent) => {
      const div = document.querySelector(`#super-container-${id} .container`)
      if (div) div.classList.toggle('showDeps')
      e.stopPropagation()
    }

  if (!window['_handleDependentsSummaryClick'])
    window['_handleDependentsSummaryClick'] = (id: string, e: MouseEvent) => {
      const div = document.querySelector(`#super-container-${id} .container`)
      if (div) div.classList.toggle('showDependents')
      e.stopPropagation()
    }

  // create cache objects (subobjects are created on first entry)
  window['_elem_cache'] ??= {}
  window['_html_cache'] ??= {}
  const _elem_cache_limit_per_item = 10
  const _html_cache_limit_per_item = 10
  function limit_cache_size(cache, limit, destroy = null) {
    while (cache.size > limit) {
      const key = cache.keys().next().value
      if (destroy?.(cache.get(key)) === null) break // allow cleanup and cancellation
      cache.delete(key)
    }
  }

  function toHTML(
    text: string,
    id: string,
    deephash: string,
    labelUnique: boolean,
    contextLabel: string,
    // NOTE: passing in arrays has proven problematic (e.g. infinite render loops)
    missingTags: any, // space-separated string converted to Set
    danglingTags: any, // space-separated string converted to Set
    matchingTerms: any, // space-separated string converted to Set
    matchingTermsSecondary: any, // space-separated string converted to Set
    depsString: string,
    dependentsString: string,
    version: number,
    childrenString: string
  ) {
    // bridge reviews 177-188: candidate BYTES never enter macro expansion or the block
    // transforms below -- only opaque markers do, and a surviving marker (an enclosing
    // _removed transform may drop one with its span) reaches the final classification
    // seams, where MARKED classifies
    // each marker's placement via the inert extension registered on the parser -- a
    // marker Marked lexes in ordinary inline flow (paragraph, list item, blockquote,
    // heading, table cell) becomes a dead-frame span (decoded value assigned
    // post-render: a canonical body as inert markdown by innerHTML, a malformed candidate
    // as the fixed placeholder text); a marker inside BLOCK code (fenced or indented --
    // marked-highlight walks every block code token) is swapped for the fixed
    // placeholder in the callback, with the post-parse backstop covering the
    // inline-code residual; a marker in a link/image destination is escaped by the
    // link override or intercepted by the image override (reviews 186 §4.1, 187 §2).
    // No pre-parse fence prediction; the decoded bytes never enter THIS Markdown pass (they
    // enter only the inert-policy instance of src/inert_markdown.ts, design §2.2a amended).
    const vaultScan = scanInert(text)
    if (vaultScan.candidates.length) {
      // every claimed marker is a key (the placement/code/image seams use .has); a malformed
      // candidate keeps an UNDEFINED value so the frame population can tell validity apart
      // from a canonical body that merely equals the placeholder string
      vaultValues = new Map(vaultScan.candidates.map(candidate => [candidate.marker, candidate.value ?? undefined]))
      // the regions whose frames render child-tag marks: the index's own rule over the same
      // scan (src/inert.ts childTagRegions), so a mark exists exactly where a tag is indexed
      childTagMarkers = childTagRegions(vaultScan)
      text = vaultScan.grammarText
    } else if (vaultValues.size) {
      vaultValues = new Map()
      childTagMarkers = new Set()
    }
    // the CHAT BOUNDARIES the rule admits a region after (src/inert.ts: an `<<agent(...)>>` line
    // alone outside a fence, directly before a canonical region, by its offset into the grammar
    // text the macro pass below replaces in): its expansion is prefixed with the boundary reset,
    // so the region is framed whatever the owner's text left open before it
    const chatBoundaries = vaultValues.size ? chatResetOffsets(text, childTagMarkers) : null

    // NOTE: we exclude text (arg 0) from cache key since it should be captured in deephash
    const cache_key = 'html-' + _hash(Array.from(arguments).slice(1).toString())
    // (an entry holds the two fragments of the item's markup, see the wrapper below: `html` is
    // returned to the template, `footer` is left in footerHTML for afterUpdate to insert)
    window['_html_cache'][id] ??= new Map()
    if (window['_html_cache'][id].has(cache_key)) {
      // console.debug("toHTML skipped");
      const cached = window['_html_cache'][id].get(cache_key)
      footerHTML = cached.footer
      return cached.html
    }
    // console.debug("toHTML", name, deephash, version)

    let cacheIndex = 0 // counter to distinguish positions of identical cached elements

    // evaluate inline <<macros>> first to ensure treatment just like non-macro content
    // note text can be pre-expanded in a periodic task and we take that if available to speed up rendering
    // we re-expand on errors so we can indicate all errors (not just first) using html with custom styling
    // we also re-expand on deephash changes in case macros depend on dependencies (and not just item text)
    // we also re-expand on version changes in case macros depend on external state (e.g. global_store)
    // we do NOT re-expand on changes to search/highlight-related state (e.g. matchingTerms, contextLabel, etc)
    // NOTE: even if we re-expand on ANY change to cache_key (see above), background expansions can still dramatically improve responsiveness when large numbers of previously-unrendered items are brought up based on re-ranking or toggling of items on page, so it is important to support in all cases.
    const hasVaultCandidates = vaultScan.candidates.length > 0
    if (!hasVaultCandidates && expanded && !expanded.error && expanded.deephash == deephash && expanded.version == version) {
      text = expanded.text // use prior expansion
      cacheIndex = expanded.count
    } else {
      // console.debug('expanding macros while rendering', name)
      expanded = {} // reset macro expansion state
      const replaceMacro = (m, js, offset, string) => {
        if (!isBalanced(js)) return m // skip unbalanced macros that are probably not macros, e.g. ((x << 2) >> 2)
        // a chat boundary's expansion starts clean: the reset line and a blank line before the
        // template's block (see chatBoundaries above), in the error path too (the span of a failing
        // delimiter still heads the reply)
        const reset = chatBoundaries?.has(string.lastIndexOf('\n', offset - 1) + 1) ? CHAT_BOUNDARY_RESET + '\n\t\n' : ''
        try {
          return (
            reset +
            window['_item'](id).eval(js, {
              trigger: 'macro_' + cacheIndex++,
              cid: `${id}-${deephash}-${cacheIndex}`, // enable replacement of $cid
            })
          )
        } catch (e) {
          expanded.error ??= e // record first error & continue replacing
          // no need to log missing dependency errors
          if (!e.message.startsWith('eval missing dependencies')) console.error(`macro error in item ${name}: ${e}`)
          return reset + `<span class="macro-error" title="${_.escape(e.message)}">${js}</span>`
          // return `<span class="macro-error">MACRO ERROR: ${e.message}</span>`
        }
      }
      text = text.replace(/<<(.*?)>>/g, skipEscaped(replaceMacro))
      // save expansion if no errors -- but NEVER for candidate-bearing items (review
      // 148 §3): this text contains renderer placeholder HTML, which a macro-evaluating
      // read must never receive as semantic text
      if (!expanded.error && !hasVaultCandidates) {
        expanded.text = text
        expanded.deephash = deephash
        expanded.version = version
        expanded.count = cacheIndex
        onMacrosExpanded(index, expanded)
      }
    }

    // the block passes shared with the index's child-tag rule (src/util.js prepareBlocks)
    text = prepareBlocks(text)

    const firstTerm = matchingTerms ? matchingTerms.match(/^\S+/)[0] : ''
    matchingTerms = new Set<string>(matchingTerms.split(' ').filter(t => t))
    matchingTermsSecondary = new Set<string>(matchingTermsSecondary.split(' ').filter(t => t))
    missingTags = new Set<string>(missingTags.split(' ').filter(t => t))
    danglingTags = new Set<string>(String(danglingTags ?? '').split(' ').filter(t => t))
    if (label) {
      Array.from(matchingTerms).forEach((term: string) => {
        if (
          term[0] == '#' &&
          term.length > label.length &&
          term[label.length] == '/' &&
          term.substring(0, label.length) == label
        )
          matchingTerms.add('#' + term.substring(label.length))
      })
      Array.from(matchingTermsSecondary).forEach((term: string) => {
        if (
          term[0] == '#' &&
          term.length > label.length &&
          term[label.length] == '/' &&
          term.substring(0, label.length) == label
        )
          matchingTermsSecondary.add('#' + term.substring(label.length))
      })
    }

    // append divs for dependencies and dependents
    function depsStringToHtml(str) {
      return str
        .split(' ')
        .map(dep => {
          let spanclass = dep.match(/\((.*?)\)$/)?.pop() || ''
          if (spanclass) spanclass = 'class="' + spanclass + '"'
          dep = dep.replace(/\(.*?\)$/, '')
          const depjs = `javascript:MindBox.toggle('${dep}')`
          return `<span ${spanclass}> ${
            dep.startsWith('#')
              ? dep
              : `<mark onclick="MindBox.toggle('${dep}');_handleLinkClick('${id}','${_.escape(
                  depjs
                )}',event)" title="${_.escape(dep)}">${dep}</mark>`
          } </span>`
        })
        .join(' ')
    }

    // the footer travels through the passes below as the LAST LINE of the text, as it always has
    // (its tags are rendered by the same line pass as the item's own). its opening tag carries a
    // mark, by which the passes after Markdown find where THIS footer starts (see the hooks before
    // marked.parse, which settle the mark at Marked's input, and the wrapper): by the footer's
    // class alone the wrapper took the first such div, which an item's own markup can hold (an
    // `_html` block), for the generated one
    const FOOTER = '<div class="deps-and-dependents">'
    const FOOTER_MARKED = '<div class="deps-and-dependents" _footer="0">'
    let depsTitle = ''
    let dependentsTitle = ''
    const footerAppended = !!(depsString || dependentsString)
    if (footerAppended) {
      text += '\n' + FOOTER_MARKED
      if (depsString) {
        depsTitle = `${depsString.split(' ').length} dependencies`
        text += `<span class="deps"><span class="deps-title" onclick="_handleDepsSummaryClick('${id}',event)">${depsTitle}</span> ${depsStringToHtml(
          depsString
        )}</span> `
      }
      if (dependentsString) {
        dependentsTitle = `${dependentsString.split(' ').length} dependents`
        text += `<span class="dependents"><span class="dependents-title" onclick="_handleDependentsSummaryClick('${id}',event)">${dependentsTitle}</span> ${depsStringToHtml(
          dependentsString
        )}</span>`
      }
      text += '</div>'
    }

    // remove removed sections, except inside blocks (src/util.js removeSections, shared with the index's child-tag rule)
    text = removeSections(text)

    // extract _log blocks (processed for summary at bottom)
    const log = extractBlock(scanInert(text).grammarText, '_log')

    // introduce a line break between any styling html and first tag
    text = text.replace(/^(<.*>)\s+#/, '$1\n#')

    // parse tags and construct regex for matching
    const tags = parseTags(text).raw
    const regexTags = tags.map(_.escapeRegExp).sort((a, b) => b.length - a.length)
    const tagRegex = `(^|\\s|\\()(${regexTags.join('|')})`
    const isMenu = tags.includes('#_menu')

    // replace naked URLs (regex from util.js) with markdown links (or images) named after host name
    // we use the same exclusions as tags (or replaceTags) to skip code blocks, html tags, etc
    const urlRegex = new RegExp(tagRegexExclusions + '|' + urlRegExp().source, 'gi')
    const host_base = location.host
    const replaceURLs = text =>
      text.replace(urlRegex, (m, pfx, url, offset, orig_str) => {
        if (pfx === undefined) return m // skip exclusion
        // disallow matching prefix ](\s+ to avoid matching urls inside markdown links
        if (orig_str.substring(0, offset + pfx.length).match(/\]\(\s*$/)) return m
        if (window['_shortcut_hosts']?.some(h => url.startsWith(h + '/'))) url = 'http://' + url
        let sfx = ''
        if (url[url.length - 1].match(/[\.,;:]/)) {
          // move certain last characters out of the url
          sfx = url[url.length - 1] + sfx
          url = url.substring(0, url.length - 1)
        }
        // convert dropbox urls to direct download
        url = url.replace('www.dropbox.com', 'dl.dropboxusercontent.com')
        url = url.replace('?dl=0', '')
        try {
          let { host, pathname, search, hash } = new URL(url)
          // drop suffix of host shared with host_base
          for (let i = 0; i < host.length; i++) {
            if (host_base.endsWith(host.substring(i))) {
              host = host.substring(0, i)
              break
            }
          }
          if (pathname == '/') pathname = ''
          if (!pathname && !host) host = host_base // do not allow empty host + path
          let label = host + ((pathname + search + hash).length > 1 ? '/…' : '')
          if (window['_shortcut_hosts']?.includes(host)) label = host + pathname + (search + hash ? '/…' : '')
          if (url.match(/\.(jpeg|jpg|png|gif|svg)$/i)) {
            return `${pfx}<img title="${_.escape(label)}" src="${url}">${sfx}`
          }
          return `${pfx}[${label}](${url})${sfx}`
        } catch (_) {
          return pfx + url + sfx
        }
      })

    const regexTerms = Array.from(matchingTerms as Iterable<string>)
      .map(_.escapeRegExp)
      .sort((a, b) => b.length - a.length)
    let mathTermRegex = new RegExp(`\$\`.*(?:${regexTerms.join('|')}).*\`\$`, 'i')

    const parentLabel = label.replace(/\/[^\/]*$/, '')
    const parentLabelText = labelText.replace(/\/[^\/]*$/, '')
    const grandParentLabel = label.replace(/\/[^\/]*?\/[^\/]*$/, '')
    const grandParentLabelText = labelText.replace(/\/[^\/]*?\/[^\/]*$/, '')

    // wiki links (src/wiki_links.ts; design wiki_links 2.3): under the account's setting every
    // wiki-shaped span outside code is MASKED for the line pass (the tag, url and math rewrites
    // would otherwise turn a `#tag` or a url inside the span into markup that the extension can
    // only show as text) and restored right after it, for the Marked extension registered
    // below; the exclusions are the tag pass's (code spans, html, macros), so a span inside
    // inline code keeps its brackets
    const wikiConfig = window['_wiki_links'] ?? null
    const wikiMasked: string[] = []
    const wikiMaskRegex = wikiConfig ? new RegExp(tagRegexExclusions + '|' + wikiLinkRegExp().source, 'gs') : null
    let insideBlock = false
    let lastLine = ''
    let wrapMath = m =>
      `<span class="${m.startsWith('$$') || !m.startsWith('$') ? 'math-display' : 'math'}" _cache_key="${id}-${_hash(
        m
      )}-${cacheIndex++}">${m}</span>`
    text = text
      .split('\n')
      .map(line => {
        let str = line
        if (!insideBlock && str.match(/^\s*```/s)) insideBlock = true
        else if (insideBlock && str.match(/^\s*```\s*$/s)) {
          insideBlock = false
          lastLine = line
          return str
        }

        // also detect indented blocks
        const indentedBlock = !!str.match(/^     *(?:[^-*+ ]| *$)/)

        // start indented blocks with an extra \n
        if (!insideBlock && indentedBlock && !lastLine.match(/^     *(?:[^-*+ ]| *$)/)) str = '\n' + str

        // skip further processing inside blocks, including indented blocks
        if (insideBlock || indentedBlock) {
          lastLine = line
          return str
        }

        // mask wiki links (see wikiMaskRegex above); an exclusion match has no groups
        if (wikiMaskRegex)
          str = str.replace(wikiMaskRegex, (m, embed) =>
            embed === undefined ? m : `\u0000wiki${wikiMasked.push(m) - 1}\u0000`
          )

        // suffix html lines with \n for proper treatment in markdown parser
        const html_line = str.match(/^\s*<\/?\w.*>\s*$/)
        if (html_line) str += '\n'

        // break non-html lines in menu items using <br> w/ flex-display paragraphs (<p> tags)
        // this forces marked to generate separate paragraphs for each line
        // otherwise marked.parse(..., {breaks:true}) does NOT break lines
        if (isMenu && !html_line) str += '<br>\n'

        // highlight errors/warnings using console styling even if outside blocks
        // (to be consistent with detection/ordering logic in index.svelte onEditorChange)
        if (str.match(/^(?:ERROR|WARNING):/)) {
          str = str
            .replace(/^(ERROR:.+?)(; STACK:|$)/, '<span class="console-error">$1</span>$2')
            .replace(/^(WARNING:.*)$/, '<span class="console-warn">$1</span>')
            .replace(/(; STACK:.+)$/, '<span class="console-debug">$1</span>')
        }

        // preserve extra spaces between non-whitespace, except inside or between html tags (using exclusion prefix)
        // NOTE: disabling this as it is also problematic in table syntax (where spacing can be used to align columns)
        // str = str.replace(
        //   /<\w(?:"[^"]*"|[^>"])*?>.*(?:<\/\w(?:"[^"]*"|[^>"])*?>)?|(\S) ( +)(\S)/g,
        //   (m, pfx, spc, sfx) => {
        //     if (!pfx) return m // matched inside html tag
        //     return pfx + spc.replace(/ /g, '&nbsp;') + sfx
        //   }
        // )

        // insert spacers at empty lines (otherwise ignored by marked)
        // using <br> (vs &nbsp;) avoids non-breaking of certain syntax (e.g. tables)
        // adding &nbsp; helps realize lines between inline elements
        //   e.g. images, where <img>\n<br>\n<img> does not create a line
        if (str.match(/^ *$/)) str += '&nbsp;<br>\n'

        // insert spacers at empty lines in blockquotes (otherwise ignored by marked)
        // using non-breaking space (&nbsp;) avoid breaking blockquotes
        if (str.match(/^ *>[> ]*$/)) str += '&nbsp;'

        // wrap math inside span.math (unless text matches search terms)
        if (matchingTerms.size == 0 || (!str.match(mathTermRegex) && !matchingTerms.has('$')))
          str = str.replace(/\$\$`.+?`\$\$|\$`.+?`\$/g, skipEscaped(wrapMath))

        // style vertical separator bar (│)
        str = str.replace(/│/g, '<span class="vertical-bar">│</span>')

        // wrap #tags inside clickable <mark></mark>
        if (tags.length) {
          str = replaceTags(str, tagRegex, (m, pfx, tag, offset, orig_str) => {
            // disallow matching prefix ](\s+ to avoid matching tag links (unlike in editor where we want them)
            if (orig_str.substring(0, offset + pfx.length).match(/\]\(\s*$/)) return m
            // drop hidden tag prefix
            const hidden = tag.startsWith('#_')
            tag = tag.replace(/^#_/, '#')
            // make relative tags absolute with the shared resolver (src/inert.ts), as the item's tags are: the
            // component's own arithmetic made a root's `#//x` the child `#root/x`, so the mark and the tags
            // disagreed (the owner's ranking row, 2026-10-04). The token as written is kept for a dangling
            // mark, and a token no label can resolve (`#///x` under a root) is dangling as well
            const relative = label && tag != label && tag.startsWith('#/')
            const raw = tag
            const resolved = relative ? resolveRelativeTag(labelText, tag) : tag
            const unresolvable = relative && !resolved
            if (resolved) tag = resolved

            const lctag = tag.toLowerCase()
            let classNames = ''
            // a VISIBLE relative tag no item carries is DANGLING, not missing (the owner, 2026-10-03): the
            // token as written, styled like inline code, faded, a dim dashed border, not clickable; no error
            // border. A hidden one (a dependency, absent or duplicated) keeps its missing diagnostic
            const dangling = relative && !hidden && (unresolvable || danglingTags.has(lctag))
            if (dangling) classNames += ' dangling'
            else if (missingTags.has(lctag)) classNames += ' missing'
            if (hidden) classNames += ' hidden'
            if (lctag == label) {
              classNames += ' label'
              if (labelUnique) classNames += ' unique'
            }
            classNames = classNames.trim()
            // if (depline) classNames = ""; // disable styling for deps/dependents
            if (classNames) classNames = ` class="${classNames}"`

            // shorten tag if possible
            // we can shorten children (<label>/child) and siblings (<parentLabel>/sibling) and parent-siblings (<grandParentLabel>/parent)
            let reltag = tag
            if (
              label &&
              tag.length > label.length &&
              tag[label.length] == '/' &&
              tag.substring(0, label.length) == labelText
            )
              reltag = '#' + tag.substring(label.length)
            else if (
              parentLabel &&
              tag != labelText &&
              tag.length > parentLabel.length &&
              tag[parentLabel.length] == '/' &&
              tag.substring(0, parentLabel.length) == parentLabelText
            )
              reltag = '#' + tag.substring(parentLabel.length)
            else if (
              grandParentLabel &&
              tag != labelText &&
              tag.length > grandParentLabel.length &&
              tag[grandParentLabel.length] == '/' &&
              tag.substring(0, grandParentLabel.length) == grandParentLabelText
            )
              reltag = '#' + tag.substring(grandParentLabel.length)

            // shorten selected label to its context label (i.e. closest existing ancestor name)
            // always include short (2-digits or less) numeric label suffixes (e.g. .../99/9/9) to help disambiguate,
            // but collapse the leading run of /0 segments (the main branch of a chain) to the last one: a
            // chain of continuations reads #…/0 at any depth, a branch keeps its deviation, #…/1/0/0
            const shortened = (base: string) =>
              '#…' + tag.substring(base.replace(/(?:\/\d\d?)+$/, '').length).replace(/^(?:\/0)+(?=\/)/, '')
            if (lctag == label && contextLabel && (matchingTerms.has(lctag) || matchingTermsSecondary.has(lctag)))
              reltag = shortened(contextLabel)

            // shorten prefix-matching labels, including short numeric suffix (see comment above)
            if (
              lctag == label &&
              label.includes('/') &&
              label.length > firstTerm.length &&
              label[firstTerm.length] == '/' &&
              label.substring(0, firstTerm.length) == firstTerm
            )
              reltag = shortened(firstTerm)
            if (dangling) return `${pfx}<mark${classNames} title="${_.escape(tag)}">${_.escape(raw)}</mark>`
            return (
              `${pfx}<mark${classNames} title="${_.escape(tag)}" onmousedown=` +
              `"_handleTagClick('${id}','${_.escape(tag)}','${_.escape(
                reltag
              )}',event)" onclick="event.preventDefault();event.stopPropagation();">` +
              `${renderTag(reltag)}</mark>`
            )
          })
        }

        // replace URLs (except in lines that look like a reference-style link)
        if (!str.match(/^\s*\[[^^].*\]:/)) str = replaceURLs(str)

        // close bullet lists with extra \n before next line
        if (lastLine.match(/^\s*(?:\d+\.|[-*+])/) && !line.match(/^\s*(?:\d+\.|[-*+])/)) str = '\n' + str

        // handle horizontal rule syntax and disable heading syntax based on -|= to prevent ambiguity
        if (str.match(/^ *(?:---+|___+|\*\*\*+) *$/)) str = `<hr>\n`
        // disable heading syntax based on -|= to prevent ambiguity w/ horizontal rule syntax
        // we do this by inserting an empty line that is removed post-markdown
        else if (line.match(/^ *(?:-+|=+) *$/)) str += ' &nbsp;'

        // close table with extra \n to prevent leading pipe ambiguity (now required) and line-eating
        if (lastLine.match(/^\s*\|/) && !line.match(/^\s*\|/)) str = '\n' + str

        // close blockquotes with an empty line when popping back up at least one level
        // see https://github.com/markedjs/marked/issues/225 for nested blockquote behavior in marked & gfm
        const last_line_blockquote_depth = lastLine
          .match(/^[> ]*/)
          .pop()
          .replace(/ /g, '').length
        const line_blockquote_depth = line
          .match(/^[> ]*/)
          .pop()
          .replace(/ /g, '').length
        if (line_blockquote_depth < last_line_blockquote_depth) str = line.match(/^[> ]*/).pop() + '\n' + str

        lastLine = line
        return str
      })
      .join('\n')
      .replace(/\\\n/g, '')
      .replace(/\\<br>\n\n/g, '') // used inside menu items
    // restore the masked wiki links for the extension
    if (wikiMasked.length) text = text.replace(/\u0000wiki(\d+)\u0000/g, (m, n) => wikiMasked[+n])

    // remove *_removed blocks (src/util.js removeRemovedBlocks, shared with the index's child-tag rule)
    text = removeRemovedBlocks(text)

    // hide *_hidden blocks
    text = text.replace(blockRegExp(/\S*_hidden/), (m, pfx) => `${pfx}<!--hidden-->\n ${m} \n<!--/hidden-->\n`)

    // hide hidden sections, except inside blocks
    text = text.replace(
      exclusionRegExp(blockExclusions, /<\!-- *hidden *-->(.*?)<\!-- *\/hidden *--> *?(?=\n|$)/gs),
      skipExclusions((m, body, sfx) => `<div style="display: none;">\n${body}\n</div>\n`)
    )

    // replace #item between style tags (can be inside _html or not) for use in item-specific css-styles
    // (#$id could also be used inside _html blocks but will break css highlighting)
    text = text.replace(
      /<[s]tyle>.*?#item\W.*?<\/style>/gs,
      skipEscaped(m => m.replace(/#item(?=\W)/g, `#item-${id}`))
    )

    // convert markdown to html
    let marked = new Marked()
    let renderer = new marked.Renderer()
    // restore the auto-generated heading ids of old marked (headerIds, removed in marked 5),
    // e.g. "#### Heading 1" gets id "heading-1" for ##fragment links (see renderer.link below)
    const headingIds = new Map()
    renderer.heading = function ({ tokens, depth }) {
      const raw = tokens.map(token => token.raw ?? '').join('')
      let id = raw
        .toLowerCase()
        .trim()
        .replace(/<[!/a-z].*?>/gi, '')
        .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
        .replace(/\s/g, '-')
      const count = headingIds.get(id) ?? 0
      headingIds.set(id, count + 1)
      if (count) id += '-' + count
      return `<h${depth} id="${_.escape(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`
    }
    // NOTE: the token's `text` is the RAW label markdown (marked's default renderer parses
    // `tokens` for the visible content), so a label with inline markup -- `[**x**](url)`,
    // [`x`](url), the [`` Object.keys ``](docs) links of js_table -- must render its tokens or
    // the markup shows literally (the regression of the 2026-08-23 renderer activation `5489389`)
    renderer.link = function ({ href, text, title, tokens }) {
      const label_html = this.parser.parseInline(tokens)
      if (window['_shortcut_hosts']?.some(h => href.startsWith(h + '/'))) href = 'http://' + href
      if (href.startsWith('##')) {
        // fragment link
        const fragment = href.substring(1)
        return `<a href="${_.escape(fragment)}" title="${_.escape(href)}" onclick="_handleLinkClick('${id}','${_.escape(
          href
        )}',event)">${label_html}</a>`
      } else if (href.startsWith('#')) {
        // tag link
        let tag = href
        // make relative tag absolute with the shared resolver, as for the plain tag marks above
        const relative = label && tag.startsWith('#/')
        const resolved = relative ? resolveRelativeTag(labelText, tag) : tag
        const unresolvable = relative && !resolved
        if (resolved) tag = resolved
        const lctag = tag.toLowerCase()
        let classNames = 'link'
        const dangling = relative && (unresolvable || danglingTags.has(lctag)) // as for the plain tag marks above
        if (dangling) classNames += ' dangling'
        else if (missingTags.has(lctag)) classNames += ' missing'
        classNames = classNames.trim()
        // the click handler maps the caret to a tag component through the DISPLAYED text
        // (index.svelte onTagClick: `renderTag(reltag)` must be the mark's text), so a formatted
        // label passes its text content, not its markdown (review link_labels 0: the raw label
        // mapped every click on the trailing component of `[**foo**/bar](#foo/bar)` to `#foo`)
        const label_holder = document.createElement('template')
        label_holder.innerHTML = label_html
        const label_text = label_holder.content.textContent ?? ''
        // the label travels as a JavaScript string literal inside an html attribute, which the
        // browser decodes BEFORE compiling the handler: build the literal first (JSON.stringify
        // escapes quotes and backslashes) and html-escape it as a whole. The callback unescapes
        // its argument (the contract of the ordinary tag marks), so that is pre-applied and the
        // callback hands back the displayed text exactly (review link_labels 1: a decoded
        // apostrophe -- `[can&#39;t](#tag)` -- made the handler a syntax error, and a code
        // label's literal `&amp;` reached the callback decoded twice)
        const label_arg = _.escape(JSON.stringify(_.escape(label_text)))
        if (dangling) return `<mark class="${classNames}" title="${_.escape(tag)}">${label_html}</mark>`
        return `<mark class="${classNames}" title="${_.escape(tag)}" onmousedown="_handleTagClick('${id}','${_.escape(
          tag
        )}',${label_arg},event)" onclick="event.preventDefault();event.stopPropagation();">${label_html}</mark>`
      }
      // For javascript links we do not use target="_blank" because it is unnecessary, and also because in Chrome it causes the javascript to be executed on the new tab and can trigger extra history or popup blocking there.
      // NOTE: rel="opener" is NOT required for target="_blank" (a misconception recorded here earlier): it GRANTS the destination an opener relationship, so it is kept only for these owner-authored links (a separate change may drop it; model-supplied links in src/inert_markdown.ts use noopener).
      let attribs = ''
      if (!href.startsWith('javascript:')) attribs = ` target="_blank" rel="opener"`
      return `<a${attribs} title="${_.escape(href)}" href="${_.escape(
        href
      )}" onclick="_handleLinkClick('${id}','${_.escape(href)}',event)">${label_html}</a>`
    }
    // a claimed region inside LINK/IMAGE DESTINATION syntax lands in the token's
    // href (review 186 §4.1): the app's link override _.escape()s it so the post-parse
    // backstop rewrites it, but Marked's default image renderer percent-encodes the
    // marker into a live src request before the backstop can match -- intercept and
    // render the fixed placeholder instead (returning false keeps the default for
    // ordinary images)
    renderer.image = ({ href }) => {
      // RAW comparison only (review 187 §2): Marked hands overrides the raw href and
      // URL-encodes solely in its default renderer, so a generated marker arrives here
      // verbatim -- while owner text that percent-ENCODES a marker lookalike must fall
      // through as an ordinary image (decoding it would let owner text impersonate a
      // collision-free marker and suppress a real image)
      for (const m of (href ?? '').matchAll(new RegExp(INERT_MARKER_SOURCE, 'g')))
        if (vaultValues.has(m[0])) return _.escape(INERT_FENCED_PLACEHOLDER)
      return false
    }
    marked.use({ renderer }) // note a bare renderer instance is silently ignored by marked.use
    // the wiki links extension (src/wiki_links.ts), only under the setting: an unconfigured
    // account renders exactly as before
    if (wikiConfig) marked.use({ extensions: [wikiLinkExtension(() => wikiConfig)] })
    // the INERT extension (bridge reviews 182-184): an inline tokenizer for the grammar
    // markers of THIS render's claimed regions. Marked runs inline tokenizers wherever it
    // lexes ORDINARY TEXT (a paragraph, list item, blockquote, heading, table cell) but
    // NEVER inside a code token, so a marker in ordinary inline flow becomes a dead-frame
    // span here while a marker inside code is swapped for the fixed placeholder in the
    // markedHighlight callback below. The span is populated post-render by its
    // data-vault-marker (afterUpdate: inert markdown for a canonical body, placeholder text
    // for a malformed one); candidate bytes never enter THIS html. Only markers
    // of the current scan match (owner-typed lookalikes are ignored).
    const inertGlobal = new RegExp(INERT_MARKER_SOURCE, 'g')
    if (vaultValues.size) {
      const inertOpen = new RegExp('^' + INERT_MARKER_SOURCE)
      marked.use({
        extensions: [
          {
            name: 'inertRegion',
            level: 'inline',
            start: (src: string) => src.indexOf('⟦vault_result_v1:'),
            tokenizer(src: string) {
              const match = inertOpen.exec(src)
              if (match && vaultValues.has(match[0]))
                return { type: 'inertRegion', raw: match[0], marker: match[0] }
              return undefined
            },
            renderer: (token: any) =>
              `<span class="vault-result" data-vault-marker="${token.marker}"></span>`,
          },
        ],
      })
    }
    // the table extension keeps a table's cells in its token's `header` and `rows`, which Marked
    // walks only where they are registered as the token's children: registered here, so that the
    // walk of the hook below reaches each cell's own inline tokens (a footer line that a line
    // continuation joins onto a table's last cell is inline html of that cell)
    const tables = markedExtendedTables()
    for (const extension of tables.extensions) extension.childTokens = ['header', 'rows']
    marked.use(tables)
    marked.use(
      markedHighlight({
        langPrefix: '',
        highlight: (code, language) => {
          // a claimed region MARKED lexed inside this code block becomes the fixed
          // placeholder HERE, at the exact seam where raw code enters highlight.js --
          // before highlight.js can fragment the marker into spans and leak it (review
          // 182 §1.1). marked-highlight walks every BLOCK code token (fenced and
          // indented); ordinary-inline markers never reach it (the inline extension
          // already rendered them), and inline-code markers are the post-parse
          // backstop's residual.
          if (vaultValues.size)
            code = code.replace(inertGlobal, (m: string) =>
              vaultValues.has(m) ? INERT_FENCED_PLACEHOLDER : m
            )
          // leave _html(_*) block as is to be "unwrapped" below
          // except add a closing comment to allow html itself to contain </code></pre>
          if (language.match(/^_html(_|$)/)) {
            return (
              code
                .replace(/\$id/g, skipEscaped(id))
                .replace(/\$name/g, skipEscaped(name))
                .replace(/\$hash/g, skipEscaped(hash))
                .replace(/\$deephash/g, skipEscaped(deephash))
                .replace(/\$cid/g, skipEscaped(`${id}-${deephash}-${++cacheIndex}`)) + '<!--/_html-->'
            )
          }
          return highlight(code, language)
        },
      })
    )

    // WHERE THE GENERATED FOOTER'S LINE WENT is Marked's to say, not a prediction of ours.
    // - the mark is the appended opening's ALONE, at the input Marked receives (preprocess): the
    //   line is the last of the text, so the LAST opening of its spelling there is the appended
    //   one, and where the text before it holds the same spelling (an item's own copy, typed or
    //   put together by a line continuation) the appended one gets a number that this input does
    //   not hold. chosen any earlier, the mark could come into being elsewhere afterwards.
    // - a token whose `raw` holds that mark whole therefore holds the appended opening, and the
    //   innermost such token is what the line became (the walk visits a token's children after
    //   it: the cells of a table too, see the table extension above). an opening that Marked
    //   split, the `<` behind an escaping backslash, is whole in no inline token: its paragraph
    //   or its table is then the innermost.
    // - that token is html, or the code of an `_html` block (unwrapped into markup below): the
    //   opening is markup in what Marked returns, and the wrapper cuts the footer off at it.
    // - it is anything else (the code of a fence or of an indented block that the text left open,
    //   a paragraph or a table whose text holds the escaped opening): the line is no markup and
    //   there is no footer to cut off (the summaries are generated all the same). the text is
    //   lexed again WITHOUT the mark, so it is rendered exactly as it always was.
    // the tokens are read after the lexer and before marked-highlight walks them (processAllTokens).
    // until 2026-11-19 the line pass above guessed at this from the lines' own look, and guessed
    // wrong where a line of three backticks was not a fence to Marked (inside a `<pre>` or a
    // textarea, in an indented block) or a fence was of tildes
    const markedOptions = { breaks: true } // adding <br> on a each single line break, see https://marked.js.org/using_advanced#options
    let footerMark = FOOTER_MARKED // the appended opening, as Marked's input holds it
    let footerIsMarkup = false
    if (footerAppended) {
      let around: [string, string] | null = null // Marked's input before and after the appended opening
      marked.use({
        hooks: {
          preprocess(src) {
            const at = src.lastIndexOf(FOOTER_MARKED)
            if (at < 0) return src
            around = [src.slice(0, at), src.slice(at + FOOTER_MARKED.length)]
            for (let n = 1; around.some(part => part.includes(footerMark)); n++) footerMark = `<div class="deps-and-dependents" _footer="${n}">`
            return around[0] + footerMark + around[1]
          },
          processAllTokens(tokens) {
            if (!around) return tokens
            let holder = null
            const holds = token => !!token.raw?.includes(footerMark)
            for (let i = tokens.length - 1; i >= 0 && !holder; i--)
              if (holds(tokens[i])) marked.walkTokens([tokens[i]], token => void (holds(token) && (holder = token)))
            footerIsMarkup = holder?.type == 'html' || (holder?.type == 'code' && !!(holder.lang ?? '').match(/\S*/)[0].match(/^_html(_|$)/))
            if (footerIsMarkup) return tokens
            return marked.lexer(around[0] + FOOTER + around[1], { ...marked.defaults, ...markedOptions })
          },
        },
      })
    }

    // assign indices to checkboxes to be moved into _checkbox_index attribute below
    // adding text after checkbox also allows checkbox items that start w/ tag (<mark>) or other html
    let checkboxIndex = 0
    text = text.replace(/(?:^|\n)\s*(?:\d+\.|[-*+]) \[[xX ]\] /g, m => m + '%%' + checkboxIndex++ + '%%')

    // parse markdown
    text = marked.parse(text, markedOptions)

    // BACKSTOP (review 182 §1.2): any contiguous marker Marked left as literal text
    // outside a highlighted code block and outside a dead-frame span (e.g. a marker at
    // the top level of a structure Marked did not tokenize as code) becomes the fixed
    // placeholder. The negative lookbehind spares the marker the inert extension wrote
    // into a span's own data-vault-marker attribute (afterUpdate reads the value there).
    if (vaultValues.size)
      text = text.replace(
        new RegExp('(?<!data-vault-marker=")' + INERT_MARKER_SOURCE, 'g'),
        m => (vaultValues.has(m) ? _.escape(INERT_FENCED_PLACEHOLDER) : m)
      )

    // remove all whitespace before </code></pre> close tag (mainly to remove single space added by marked)
    // NOTE: you can test by creating an empty block and seeing its size and non-matching of :empty
    text = text.replace(/\s+<\/code><\/pre>/gs, '</code></pre>')

    // also remove all newlines after <code><pre> open tag
    // one benefit is free line-spacing in editor between block delimiters and contents
    text = text.replace(/(<pre><code(?:"[^"]*"|[^>"])*>)\n*/gs, '$1')

    // remove empty table headers (thead) generated by marked
    text = text.replace(/<thead>\s*<tr>\s*(?:<th>\s*<\/th>\s*)*\s*<\/tr>\s*<\/thead>/g, '')

    // unwrap _html(_*) blocks, except for empty ones (so they remain visible via code:empty styling)
    text = text.replace(/<pre><code class="_html_?.*?">(.*?<!--\/_html-->)<\/code><\/pre>/gs, (m, _html) => {
      if (_html.trim() == '<!--/_html-->') return m.replace(/<\!--\/_html-->$/, '')
      return _html.replace(/<\!--\/_html-->$/, '')
    })

    // replace non-empty _math blocks
    // replace _math blocks, preserving whitespace
    text = text.replace(/<pre><code class="_math">(.*?)<\/code><\/pre>/gs, (m, _math) => {
      if (!_math.trim()) return m
      return wrapMath(_math)
    })

    // allow escaping of math ($), macro (&lt;,@), and table (|) delimiters in inline code blocks
    text = text.replace(/<code>(.*?)<\/code>/g, (m, code) => {
      code = code.replace(/\\\$/g, '$$')
      code = code.replace(/\\&lt;/g, '&lt;')
      code = code.replace(/\\@/g, '@')
      code = code.replace(/\\\|/g, '|')
      return `<code>${code}</code>`
    })

    // allow escaping pipes in inline code blocks, to avoid confusion w/ table syntax
    text = text.replace(/(<code>.*?)\\\|(.*?<\/code>)/g, '$1|$2') // \$`

    // wrap item content in .content div, adding .menu class for #menu items
    // also perform _static_ (vs dynamic in afterUpdate) removal of tail whitespace
    // THE ITEM'S MARKUP IS TWO FRAGMENTS (2026-11-18): `text` from here on is the item's own body,
    // the wrapper's opening tag and the content, with NO closing tag; `footer` is what is generated
    // after it (.deps-and-dependents, then below the log, deps and dependents summaries). the
    // template gives the body to the browser alone, which closes whatever it leaves open at the end
    // of its input, and afterUpdate inserts the footer after it, parsed on its own: the footer and
    // the summaries are children of .item whatever the content holds, which their styles need.
    // until then the two were one string, closed in between by one `</div>`: a div left open in the
    // content (the owner's `columns()` macro leaves one, on purpose) took that tag, .content stayed
    // open and held the footer and the summaries, out of reach of their layout and toggle rules and
    // so always shown (since 2022-11-10, when those became child rules); an unclosed `<b>` or `<a>`
    // was opened again by the parser inside the footer; an open table cell, textarea or template
    // took the footer in. the wrapper
    // is parsed WITH the content, as before: a stray `</div>` in the content still closes it early
    // and what follows is the item's child. the boundary is the generated footer's own opening tag:
    // the one that carries the mark in what Marked returned, where its tokens said that the
    // footer's line is markup (footerIsMarkup and footerMark, above); the mark is left behind.
    // without a generated footer, or where its line is no markup, the body is the whole text
    const footerAt = footerIsMarkup ? text.lastIndexOf(footerMark) : -1
    let footer = footerAt < 0 ? '' : FOOTER + text.slice(footerAt + footerMark.length)
    {
      let content = footerAt < 0 ? text : text.slice(0, footerAt)
      const keep = []
      let length = 0
      do {
        length = content.length
        content = content
          .replace(/(?:\s|<br>)*$/, '')
          .replace(
            /(?:<br>|&nbsp;|\s|<mark class="(?:[^"]*\s)?hidden(?:\s[^"]*)?"(?:"[^"]*"|[^>"])*>\S*?<\/mark>)*((?:<\/p>)?)$/,
            (m, sfx) => {
              keep.push(...(m.match(/<mark class="(?:[^"]*\s)?hidden(?:\s[^"]*)?"(?:"[^"]*"|[^>"])*>\S*?<\/mark>/g) ?? []))
              return sfx
            }
          )
          .replace(/<p>(?:<\/p>)?$/, '') // drop empty <p> tag, allowing unclosed <p> as well
          // (a hidden tag's mark may carry other classes, e.g. `missing hidden`)
          // note <> should be escaped in code blocks, so we can use that to avoid matching across blocks
          // (the block's lines may carry level spans, see util.js)
          .replace(/<pre><code class="_log">(?:(?!<\/pre>).)*<\/code><\/pre>$/s, m => (keep.push(m), ''))
      } while (content.length < length) // keep trying until content length is unchanged
      if (keep.length) content += '\n' + keep.join(' ') + '\n'
      // draw every direct tree child as a real tag mark: inline right after the label when the item
      // shows nothing besides its label, else in a block of their own in `footer` (inserted after
      // `.content` as a separate fragment so unclosed HTML in `.content` cannot swallow them).
      // Any child already shown visibly by another mark (written prose or an open agent inert section)
      // is hidden post-render by `syncRepeatedChildTags` using the browser's own visibility test.
      // Shown only: never part of the item's tags, text, deps or search matches
      const children = childrenString ? childrenString.split(' ').filter(Boolean) : []
      if (children.length && label && labelUnique && !fixed) {
        const marksHtml = renderChildMarks(id, label, children)
        if (!isMenu && isNameOnlyContent(content)) content = insertInlineChildTags(content, marksHtml)
        else footer = `<div class="child-tags">${marksHtml}</div>` + (footer ? '\n' + footer : '')
      }
      text = `<div class="content${isMenu ? ' menu' : ''}">` + content
    }

    // wrap list items in span to control spacing from bullets
    text = text.replace(/<li>/gs, '<li><span class="list-item">').replace(/<\/li>/gs, '</span></li>')

    // move checkbox indices into attributes
    text = text.replace(/(<input\s(?:"[^"]*"|[^>"])*?type="checkbox">\s*)%%(\d+)%%/gi, (m, box, index) => {
      return box.replace(/>/, ` _checkbox_index=${index}>`)
    })

    // process images to transform src and add _cached attribute (skip if caching managed manually)
    text = text.replace(/<img\s(?:"[^"]*"|[^>"])*?src\s*=\s*"([^"]*)"(?:"[^"]*"|[^>"])*>/gi, (m, src) => {
      if (m.match(/_cached|_uncached|_cache_key/i)) return m
      // convert dropbox image src urls to direct download
      src = src.replace(/^https?:\/\/www\.dropbox\.com/, 'https://dl.dropboxusercontent.com').replace(/\?dl=0$/, '')
      m = m.replace(/src\s*=\s*"[^"]*"/, '') // drop src (must be consistent w/ pattern above)
      // allow onImageRendering() to change src and add other attributes as needed
      let attrs = _.assign({ src }, onImageRendering(src))
      attrs = _.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ')
      return m.substring(0, m.length - 1) + ` ${attrs} _cached>`
    })

    // process any tags with item-unique id to add _cached attribute (skip if caching managed manually)
    text = text.replace(/<\w+\s(?:"[^"]*"|[^>"])*?id\s*=\s*"(.*?)"(?:"[^"]*"|[^>"])*>/gi, (m, elemid) => {
      if (m.match(/_cached|_uncached|_cache_key/i)) return m
      if (!elemid.includes(id)) return m
      return m.substring(0, m.length - 1) + ` _cached>`
    })

    // process any tags with _cached attribute to replace it with _cache_key="$cid"
    text = text.replace(/<\w+\s(?:"[^"]*"|[^>"])*?_cached\b(?:"[^"]*"|[^>"])*>/gi, m => {
      if (m.match(/_uncached|_cache_key/i)) {
        console.warn('_cached used together with _uncached or _cache_key in item', name, ', tag:', m)
        return m
      }
      m = m.replace(/ _cached/, '')
      return m.substring(0, m.length - 1) + ` _cache_key="${id}-${deephash}-${++cacheIndex}">`
    })

    // add onclick handler to html links
    text = text.replace(/<a\s(?:"[^"]*"|[^>"])*?href\s*=\s*"(.*?)"(?:"[^"]*"|[^>"])*>/gi, function (m, href) {
      if (m.match(/onclick/i)) return m // link has custom onclick handler
      if (m.match(/data-wiki-link/i)) return m // a wiki link carries data only; wired in afterUpdate
      return m.substring(0, m.length - 1) + ` onclick="_handleLinkClick('${id}','${_.escape(href)}',event)">`
    })

    // append log summary div
    if (log) {
      const lines = log.split('\n')
      let summary = '<span class="log-triangle">▼</span>'
      lines.forEach(line => {
        // a `_`-prefixed level (a neutralized WARNING or ERROR of the bridge's task log) gets INFO's dot
        const type = line.match(/^ERROR:/)
          ? 'error'
          : line.match(/^WARNING:/)
            ? 'warn'
            : line.match(/^(?:INFO|_[A-Z]+):/)
              ? 'info'
              : line.match(/^DEBUG:/)
                ? 'debug'
                : 'log'
        summary += `<span class="log-dot console-${type}">⸱</span>`
      })
      footer += `\n<div class="log-summary" onclick="_handleLogSummaryClick('${id}',event)" title="${lines.length} log lines">${summary}</div>`
    }

    // append dependencies ("deps") summary
    if (depsString) {
      const summary =
        '<span class="deps-triangle">▼</span>' +
        depsString
          .split(' ')
          .map(dep => `<span class="deps-dot${dep.endsWith('(async)') ? ' async' : ''}">⸱</span>`)
          .join('')
      footer += `\n<div class="deps-summary" onclick="_handleDepsSummaryClick('${id}',event)" title="${depsTitle}">${summary}</div>`
    }
    // append dependents ("deps") summary
    if (dependentsString) {
      const summary =
        '<span class="dependents-triangle">▼</span>' +
        dependentsString
          .split(' ')
          .map(dep => `<span class="dependents-dot${dep.endsWith('(visible)') ? ' visible' : ''}">⸱</span>`)
          .join('')
      footer += `\n<div class="dependents-summary" onclick="_handleDependentsSummaryClick('${id}',event)" title="${dependentsTitle}">${summary}</div>`
    }


    // include html cache key in content to include in svelte content cache key and force svelte update whenever html is re-generated even if generated html is identical since arguments (in particular deephash and version) may capture changes not reflected in generated html
    // (the key goes BEFORE the body: nothing may follow a content that can leave an element open,
    // and a change of the footer alone changes the key, so the body is replaced with it and
    // afterUpdate inserts the new footer: one string still drives the replacement of all children)
    text = `<!-- html_cache_key=${cache_key} -->` + text
    footerHTML = footer

    // do not cache with macro errors
    if (expanded.error) return text
    window['_html_cache'][id].set(cache_key, { html: text, footer })
    limit_cache_size(window['_html_cache'][id], _html_cache_limit_per_item)
    return text
  }

  // we use afterUpdate hook to make changes to the DOM after rendering/updates
  import { afterUpdate, onDestroy } from 'svelte'
  let container: HTMLDivElement
  let itemdiv: HTMLDivElement
  // decoded vault-result values by marker (undefined for a malformed candidate): a canonical
  // body is rendered into its dead frame as inert markdown, a malformed one shows the fixed
  // placeholder as a text node (bridge design §2.2a, amended 2026-09-05)
  let vaultValues = new Map<string, string | undefined>() // marker -> decoded value / undefined
  let childTagMarkers = new Set<string>() // the frames that render child-tag marks (src/inert.ts)
  // the generated footer of the markup toHTML returned last (.deps-and-dependents and the
  // summaries; empty for an item without dependencies, dependents or log lines): afterUpdate
  // inserts it after the body, as a fragment of its own (see the wrapper in toHTML)
  let footerHTML = ''

  // hide any drawn `mark.child-tag` whose tag another visible mark of this item already shows
  // (written prose or an open agent inert section), using the browser's own box-visibility test
  // (`isMarkVisible`) for supported hiding cases (`<!--hidden-->`, `[hidden]`, closed `<details>`,
  // folded `.inert-block` frames, closed `#template` toggles, `mark.hidden`, `.repeated`; not
  // `visibility: hidden` or owner CSS inside a reply). Runs on the item's update, an inert block's
  // toggle, a capturing native `toggle` inside the item, and the `#template` toggle's resize hook;
  // touches only items that have drawn marks and never re-enters Svelte's afterUpdate
  function syncRepeatedChildTags() {
    if (!itemdiv) return
    const drawn = itemdiv.querySelectorAll('mark.child-tag')
    if (!drawn.length) return
    const shown = new Set<string>()
    itemdiv.querySelectorAll('mark:not(.child-tag, .label, .deps-and-dependents *)').forEach(mark => {
      if (!isMarkVisible(mark)) return
      const title = mark.getAttribute('title')
      if (title) shown.add(title.toLowerCase())
    })
    let visibleCount = 0
    drawn.forEach(mark => {
      const repeated = shown.has((mark.getAttribute('title') ?? '').toLowerCase())
      mark.classList.toggle('repeated', repeated)
      if (!repeated) visibleCount++
    })
    itemdiv.querySelectorAll('.child-tags').forEach(box => {
      box.classList.toggle('empty', visibleCount == 0)
    })
  }

  // light or unlight drawn `mark.child-tag` marks for the active path from root without running
  // the full afterUpdate pass (which wraps custom link onclick handlers and sets up DOM controls)
  function syncChildHighlights() {
    if (!itemdiv) return
    const drawn = itemdiv.querySelectorAll('mark.child-tag')
    if (!drawn.length) return
    const matchingTermSet = matchingTerms ? new Set<string>(matchingTerms.split(' ').filter(Boolean)) : null
    const matchingTermSecondarySet = matchingTermsSecondary
      ? new Set<string>(matchingTermsSecondary.split(' ').filter(Boolean))
      : null
    const childSelectedSet = childHighlightSelected
      ? new Set<string>(childHighlightSelected.split(' ').filter(Boolean))
      : null
    const childSecondarySet = childHighlightSecondary
      ? new Set<string>(childHighlightSecondary.split(' ').filter(Boolean))
      : null
    drawn.forEach(mark => {
      const title = (mark.getAttribute('title') ?? '').toLowerCase()
      const selected = !!matchingTermSet?.has(title) || !!childSelectedSet?.has(title)
      const secondary = !selected && (!!matchingTermSecondarySet?.has(title) || !!childSecondarySet?.has(title))
      mark.classList.toggle('selected', selected)
      mark.classList.toggle('secondary-selected', secondary)
    })
  }

  function cacheElems() {
    // cache/restore elements with attribute _cache_key to/from window[_cache][_cache_key]
    itemdiv?.querySelectorAll('[_cache_key]').forEach(elem => {
      window['_elem_cache'][id] ??= new Map()
      if (elem.hasAttribute('_cached')) return // already cached/restored
      const key = elem.getAttribute('_cache_key')
      if (window['_elem_cache'][id].has(key)) {
        // console.debug("reusing cached element", key, elem.tagName, elem.id);
        // if (window["_elem_cache"][id].get(key).querySelector("script")) console.warn("cached element contains script(s)");
        let cached = window['_elem_cache'][id].get(key)
        if (document.getElementById('cache-div').contains(cached)) {
          cached.remove()
          cached.style.width = cached['_width']
          cached.style.height = cached['_height']
          cached.style.position = cached['_position']
        }
        elem.replaceWith(cached)
        elem = cached
        // resize all children and SELF w/ _resize attribute (and property)
        try {
          elem.querySelectorAll('[_resize]').forEach(e => e['_resize']?.())
          elem['_resize']?.()
        } catch (e) {
          console.error('_resize error', e)
        }
      } else {
        if (elem.querySelector('script')) return // contains script; must be cached after script is executed
        elem.setAttribute('_cached', Date.now().toString())
        // console.debug("caching element", key, elem.tagName);
        // (elem as HTMLElement).style.width = getComputedStyle(elem).width;
        window['_elem_cache'][id].set(key, elem) //.cloneNode(true);
        limit_cache_size(window['_elem_cache'][id], _elem_cache_limit_per_item, elem => {
          if (itemdiv.contains(elem)) return null // cancel deletions since oldest elem is on item
          // destroy all children and SELF via the GUARDED shared teardown (see destroyElem)
          destroyElem(elem)
        })
      }
    })
  }

  function renderMath(elems, done = null) {
    if (elems.length == 0) return
    // concurrent typesetPromise calls are unsafe (see "handling asynchronous typesetting" in the
    // mathjax docs): a run can leave the global font cache empty while another item's callback is
    // still measuring its glyph <use> refs, which then measure as zero bbox (e.g. NaN/Infinity
    // transforms in _dot_rendered); the shared queue serializes typesetting across items and runs
    // each done() before the next typeset can start
    // an INERT frame's math (a bridge reply's, src/inert_markdown.ts) is typeset by a MathJax
    // document of the frame's own (src/inert_math.ts; inert_math reviews 0-2): a plain document
    // with a fresh parser per frame over a bounded package set and this app's filter of the
    // frame's MathML, so a reply's TeX can neither define macros for the owner's math or the next
    // reply's nor carry a url, a class, an id, a style or a resource-bearing color into the
    // output, and no menu of a frame can touch the page's document. The owner's math goes
    // through the page's document as before; all run on the shared queue after MathJax's startup
    // (the page's automatic scan is off, src/app.html: this pass and the graph-text one below are
    // the only typesetters, so a frame's math never meets the page's parser), the owner's first. A frame whose typeset
    // fails keeps its TeX as text and is marked as done() marks the others (an unmarked span
    // keeps the item unrendered, and the loading overlay on the page); the other frames and the
    // item's completion go on
    const owner = elems.filter(elem => !elem.closest('.vault-result'))
    const frames = new Map<Element, Element[]>()
    for (const elem of elems) {
      const frame = elem.closest('.vault-result')
      if (!frame) continue
      if (!frames.has(frame)) frames.set(frame, [])
      frames.get(frame)!.push(elem)
    }
    // a typeset marks its spans AS IT COMPLETES (the owner's, then each frame's), not at the job's end: the
    // frames' first typeset awaits the load of their extensions, and a re-render of the item meanwhile is
    // handed the already typeset spans back by the element cache; unmarked, the pass above took them for
    // raw TeX without delimiters and put `$$` around their output (the owner, 2026-10-05)
    const mark = spans => spans.forEach(span => span.hasAttribute('_rendered') || span.setAttribute('_rendered', Date.now().toString()))
    window['_typeset_queue'] = (window['_typeset_queue'] ?? Promise.resolve())
      .then(() => window['MathJax'].startup.promise)
      .then(() => (owner.length ? window['MathJax'].typesetPromise(owner).then(() => mark(owner)) : null))
      .then(async () => {
        for (const spans of frames.values()) {
          try {
            await typesetInertMath(spans)
            mark(spans)
          } catch (e) {
            console.error(e)
            spans.forEach(span => span.setAttribute('_rendered', 'failed'))
          }
        }
      })
      .then(() => {
        const itemdiv = elems[0].closest('.item')
        if (!itemdiv) return
        // view only: typesetting turned owner TeX into NEW dom after the render-time scrub, and
        // TeX can author links (\href{javascript:...}) — re-apply the policy to what it built
        // NOTE: inTabOrder: false option updates context menu but fails to set tabindex to -1 so we do it here
        itemdiv.querySelectorAll('.MathJax').forEach(elem => elem.setAttribute('tabindex', '-1'))
        if (done) done()
        onResized(id, container, 'math rendered')
      })
      .catch(e => {
        // a typeset that fails (an extension the loader cannot fetch, offline, or an unknown
        // `\require{…}` in the owner's TeX) leaves its TeX as text, and the item still counts as
        // rendered (its spans marked as done() marks them): an unrendered visible item keeps the
        // loading overlay on the page, which intercepts every click (inert_math review 0's lane run:
        // a missing extension wedged every later row)
        console.error(e)
        elems.forEach(elem => elem.setAttribute('_rendered', 'failed'))
        if (elems[0].closest('.item')) onResized(id, container, 'math failed')
      })
  }

  // AN EXTERNAL IMAGE'S FIRST FAILURE IS RETRIED ONCE (2026-10-01): on the owner's iPhone six
  // Dropbox-hosted icons failed with "The network connection was lost" within the first seconds
  // of every launch and loaded fine a moment later (the host was up, the links alive, no service
  // worker in the way: a connection-level failure of the launch's first burst to that host). The
  // retry waits out the burst and adds a cache-busting query, so a cached failed entry cannot be
  // served again; a second failure takes the ordinary path (the error logged, `_failed`). Only an
  // http(s) image that is not the app's own pending download qualifies (the account's images
  // have their own bounded retries in onImageFailed, see index.svelte), and only once per element
  // (`_retried`); a re-render starts afresh. The page is released at the first failure as before:
  // the retry runs underneath, and its success repaints the img through the ordinary onload
  const EXTERNAL_IMAGE_RETRY_MS = 2_000
  function retryExternalImage(img: HTMLImageElement): boolean {
    const src = img.getAttribute('src') ?? ''
    if (img.hasAttribute('_pending') || img.hasAttribute('_retried') || !/^https?:\/\//.test(src)) return false
    img.setAttribute('_retried', Date.now().toString())
    console.debug(`image load failed, retrying once in ${EXTERNAL_IMAGE_RETRY_MS}ms: ${src}`)
    img.onload?.(new Event('load')) // the page is released now, as a failure releases it; the retry repaints
    setTimeout(() => {
      if (!img.isConnected) return // re-rendered or removed meanwhile
      img.src = withRetryQuery(src, Date.now())
    }, EXTERNAL_IMAGE_RETRY_MS)
    return true
  }
  // the cache-busting query goes INTO the query, before any fragment (a `#view` of an svg must
  // stay a fragment; appended to the whole string it would have joined the fragment and left
  // the request unchanged, review 0 R1); the existing query and fragment are preserved as written
  function withRetryQuery(src: string, stamp: number): string {
    const hash = src.indexOf('#')
    const base = hash < 0 ? src : src.slice(0, hash)
    const fragment = hash < 0 ? '' : src.slice(hash)
    return base + (base.includes('?') ? '&' : '?') + '_retry=' + stamp + fragment
  }

  function renderImages(id, elems) {
    cacheElems() // cache/restore any new cached elements
    // set up img elements to trigger downloading (if _pending) and invoke onResized upon loading
    elems.forEach(img => {
      if (img.hasAttribute('_rendered')) return // already rendered
      if (!img.hasAttribute('src')) {
        console.warn('img missing src')
        return
      }
      if (!img.hasAttribute('_uncached') && !img.closest('[_cache_key]'))
        console.warn('uncached image (missing _cache_key on/above element)')
      // invoke onImageRendering for image, allowing it to change src and add _pending attribute
      // note this happens in toHTML for static images already on item at render time
      // console.debug('rendering image', img.getAttribute('src'))
      const src = img.getAttribute('src')
      const attrs = _.assign({ src }, onImageRendering(src))
      _.entries(attrs).forEach(([k, v]) => img.setAttribute(k, v))
      if (img.hasAttribute('_pending')) onImageRendered(img) // trigger pending download of _src
      img.onload = () => {
        // note image is not _rendered until _pending attribute is removed by onImageRendered
        if (!img.hasAttribute('_pending')) img.setAttribute('_rendered', Date.now().toString())
        img['_resize']?.()
        // note this call has to happen after _rendered attribute is set
        // also note you can NOT access global like name here!
        // instead you have to go through window['_item'](id)
        // console.debug('image rendered', id, img)
        onResized(id, container, 'img.onload')
      }
      // also handle onerror/onabort as if image was loaded, but with a warning _failed/_aborted attribute
      // these are invoked w/ uninformative 'error' events, see https://developer.mozilla.org/en-US/docs/Web/API/Element/error_event
      img.onerror = e => {
        // note PDFs currently fail in chrome (and presumably some other browsers) so we emit a warning in that case
        if (img.getAttribute('_type') == 'application/pdf')
          console.warn('pdf image load failed (as expected in some browsers like chrome)', img, e)
        else if (retryExternalImage(img)) return // the first failure of an external image: one retry
        else console.error('image load failed', img, e)
        img.setAttribute('_failed', Date.now().toString())
        img.onload()
      }
      img.onabort = e => {
        console.warn('image load aborted', img, e)
        img.setAttribute('_aborted', Date.now().toString())
        img.onload()
      }
    })
  }

  let highlightDispatchCount = 0
  // the selection that the markers of the item's inert blocks were last told (afterUpdate, below)
  let saidTarget: boolean | null = null

  afterUpdate(() => {
    // populate vault-result dead frames (bridge design §2.2a, amended 2026-09-05): a
    // canonical decoded body is rendered as INERT MARKDOWN -- the vault renderer's policy
    // (src/inert_markdown.ts): decoded bytes enter only that local Marked instance, whose
    // trusted html is assigned by innerHTML and never sees the app's own Markdown, macro,
    // tag or url passes; the fixed invalid placeholder stays a text node. Repopulation
    // survives the app's forced rerenders (the rendered marker is remembered per frame).
    // CHILD TAGS (vault design mind_chat_children 2.2): a body's `#/name` tokens render as the
    // app's marks (the item's context: label, case, missing state) in the frames of the
    // child-tag regions alone (childTagMarkers, the index's rule); the frame's render key is
    // the marker plus the missing state of its marks, so a frame element Svelte keeps across a
    // state change updates its marks' classes in place (the selection and search classes
    // assigned below survive), while replaced content renders afresh; the frame's capture
    // listeners route a mark's mousedown (the keyboard navigation dispatches a non-bubbling
    // one on the mark) to the app's tag handler and cancel the mark's click (a mark inside a
    // link's label must not fire the anchor); everything else in the frame stays dead. (the
    // danglingTags and missingTags PROPS are the space-separated strings the caller wires; toHTML
    // converts its own parameters, never the props). A frame's marks are relative tokens: an ABSENT
    // target renders dangling whether the item's state calls the tag dangling (relative occurrences
    // only) or missing (an absolute occurrence in the owner's text names it too and keeps the red
    // mark, the border and the rank there; review 0 B1), so the frame's set is the union of both
    const absentSet = new Set<string>(
      [...String(danglingTags ?? '').split(' '), ...String(missingTags ?? '').split(' ')].filter(t => t)
    )
    const childTagContext = { id, label, labelText, danglingTags: absentSet }
    const danglingKey = (elem: Element) =>
      [...elem.querySelectorAll('mark[data-tag]')]
        .map(mark => mark.getAttribute('data-tag')!.toLowerCase())
        .filter(tag => absentSet.has(tag))
        .sort()
        .join(' ')
    let framesPopulated = false
    itemdiv?.querySelectorAll('.vault-result').forEach(elem => {
      const marker = elem.getAttribute('data-vault-marker')!
      const value = vaultValues.get(marker)
      if (value === undefined) {
        if (elem.textContent !== INVALID_INERT_REGION) elem.textContent = INVALID_INERT_REGION
        elem.removeAttribute('data-inert-rendered')
        return
      }
      const rendered = elem.getAttribute('data-inert-rendered') ?? ''
      if (!rendered.startsWith(marker + '|')) {
        elem.innerHTML = renderInertMarkdown(value, childTagMarkers.has(marker) ? childTagContext : null, labelText)
        framesPopulated = true
        // the frame's math spans join the ELEMENT CACHE (cacheElems below, as the owner's math does through
        // wrapMath's keys): a re-render of the item (a query change re-renders its html, frames included)
        // gets a frame's typeset spans back instead of typesetting them anew through a document of the
        // frame's own (a flicker and a reflow of every formula on a child navigation: the owner, 2026-10-05).
        // the KEY is the frame's whole body (with the item, the frame's marker and the span's position, for
        // duplicates), never the one formula: a frame's formulas are typeset together by one parser, so a
        // definition in one reaches the formulas after it, and an edit to any of them re-typesets the
        // frame's math as a whole (inert_math_cache review 0 B1). the cache's invalidation (util.js
        // invalidateElemCache: a code error's eval, a script pass, the owner's run or write) applies to
        // these spans as to the owner's
        const bodyKey = `${id}-${marker}-${_hash(value)}`
        elem.querySelectorAll('span.math, span.math-display').forEach((span, n) => span.setAttribute('_cache_key', `${bodyKey}-${n}`))
        elem.setAttribute('data-inert-rendered', marker + '|' + danglingKey(elem))
        if (!elem.hasAttribute('data-child-tags-wired')) {
          elem.setAttribute('data-child-tags-wired', '')
          // (a TAG LINK, `code[data-tag-link]`, is a tag written in any inert section; a COMMAND LINK,
          // `code[data-command-link]`, is an inline-code command written there, src/inert_markdown.ts: no tag
          // of the item's and no mark. both act on a completed primary CLICK that is a tap by the section's
          // own test (src/inert_blocks.ts: no selection made by the gesture, none that stood in the block at
          // its press); their PRESS is the browser's (a drag selects text, a secondary press opens the context
          // menu) and their click stops here, tap or not (no toggle, no editor). a command link also notes
          // what had focus at its primary press and gives it back on a tap before running the command, so a
          // focused MindBox keeps focus across the press while an unfocused one gets none)
          let selection = false // a selection stood in the frame's block at a tag or command link's press
          const childMark = (e: Event) => {
            const mark = (e.target as Element | null)?.closest?.('mark[data-tag], code[data-tag-link], code[data-command-link]')
            return mark && elem.contains(mark) ? mark : null
          }
          elem.addEventListener(
            'mousedown',
            (e: MouseEvent) => {
              const mark = childMark(e)
              if (mark?.hasAttribute('data-tag-link') || mark?.hasAttribute('data-command-link')) {
                selection = selectedIn(elem.closest('.inert-block') ?? elem)
                if (!fixed && mark.hasAttribute('data-command-link') && e.button == 0) {
                  commandFocus?.over.abort()
                  const pressed = (commandFocus = { elem, had: document.activeElement, over: new AbortController() })
                  const end = (ev: Event) =>
                    void ((ev.type != 'blur' || ev.target === window) && (pressed.over.abort(), setTimeout(() => void (commandFocus === pressed && (commandFocus = null)))))
                  for (const type of ['mouseup', 'dragend', 'pointercancel', 'blur'])
                    window.addEventListener(type, end, { capture: true, signal: pressed.over.signal })
                }
              }
              // a dangling mark (a relative tag no item carries) navigates nowhere; its click is still cancelled
              // below, so one inside a link does not fire the anchor either
              else if (mark && !mark.classList.contains('dangling')) window['_handleTagClick'](id, mark.getAttribute('data-tag')!, mark.getAttribute('data-reltag')!, e)
            },
            true
          )
          elem.addEventListener(
            'click',
            (e: MouseEvent) => {
              const tap = !selection && !selectedIn(e.target as Node)
              selection = false
              const had = commandFocus?.elem === elem ? commandFocus.had : null
              if (commandFocus?.elem === elem) {
                commandFocus.over.abort()
                commandFocus = null
              }
              const mark = childMark(e)
              if (!mark) return
              const cmd = mark.getAttribute('data-command-link')
              // on a shared (fixed) page a command span is inert plain code and must not block block toggles
              if (!cmd || !fixed) {
                e.preventDefault()
                e.stopPropagation()
              }
              const link = mark.getAttribute('data-tag-link')
              if (link && tap && e.button == 0) window['_handleTagClick'](id, link, '', e)
              if (cmd && tap && e.button == 0) {
                if (!fixed && had instanceof HTMLElement && had.isConnected && had !== document.activeElement)
                  had.focus({ preventScroll: true })
                onCommandClick(cmd, e)
              }
            },
            true
          )
        }
      } else if (rendered !== marker + '|' + danglingKey(elem)) {
        elem.querySelectorAll('mark[data-tag]').forEach(mark => {
          // the frame's marks are relative tags: their missing state is dangling, with the token as written
          const dangling = absentSet.has(mark.getAttribute('data-tag')!.toLowerCase())
          mark.classList.toggle('dangling', dangling)
          const reltag = mark.getAttribute('data-reltag')!
          mark.textContent = dangling ? reltag : renderTag(reltag)
        })
        elem.setAttribute('data-inert-rendered', marker + '|' + danglingKey(elem))
      }
    })
    // the item's selection changed, or this component is new (an item that changes columns gets a
    // new one): the item's manual toggles made under the other selection are forgotten, before
    // the blocks are made, which read them
    const turned = saidTarget !== target // (also while no body shows, the editor open, and whatever the item holds)
    if (turned) forgetSelection(id, (saidTarget = target), itemdiv)
    // THE BLOCKS of the frames just populated (src/inert_blocks.ts: frames that follow each other
    // under one head line, closed to that line by default, open while the item is the target or
    // the search has a match inside, and as a manual toggle left them). only after a population,
    // which is when the item's children are new: an update that keeps them does nothing here, and
    // an item without a frame never gets this far. no layout is read (a frame's textContent is
    // read while a search has terms); the open state while selected is css alone (.target, below)
    if (framesPopulated)
      inertBlocks(itemdiv, frame => vaultValues.get(frame.getAttribute('data-vault-marker')!) ?? '', {
        id,
        terms: matchingTerms + ' ' + matchingTermsSecondary, // the highlighter's terms, below
        selected: () => target,
        selecting: selectedIn,
        onStateChange: () => syncRepeatedChildTags(),
        resized: () => onResized(id, container, 'inert toggle'),
      })
    // and what each block's marker says of it (aria-expanded): after a population, and when the
    // selection changed with none (it opens and closes the blocks by css alone). not on the other
    // updates of an item with frames, which are many (a key in any editor updates several items)
    if (itemdiv && vaultValues.size && (framesPopulated || turned)) sayExpanded(itemdiv, target)
    // always report container height for potential changes
    // WARNING: afterUpdate can be triggered for _multiple_ items on every key press in the editor of a single item, so it is critical for onResized to be efficient. These updates were traced to binding such as editor.focused when focusing on an editor or editor.selectionStart when typing into an editor, and then seem to always get propagated to every item that is rendered on the page
    // console.trace()
    // console.debug('afterUpdate', name)
    setTimeout(() => onResized(id, container, 'afterUpdate'), 0)

    // destroy any expired-while-live elements that this update actually replaced (see
    // invalidateElemCache; svelte's {@html} replacement does not run _destroy hooks); this runs
    // BEFORE the editing early-return below — switching into the editor is exactly such a
    // replacement, and a retired chart/timer must not stay active for the whole editing session
    reapRetiredElems(id)

    // itemdiv or its parent can be null, e.g. if we are editing, and if so we immediately adopt any cached elements
    if (!itemdiv?.parentElement) {
      window['_elem_cache'][id]?.forEach(adoptCachedElem)
      return
    }

    // NOTE: this function must be fast and idempotent, as it can be called multiple times on the same item
    // NOTE: additional invocations can be on an existing DOM element, e.g. one with MathJax typesetting in it
    // NOTE: always invoked twice for new items due to id change after first save
    // NOTE: invoked on every sort, e.g. during search-as-you-type
    // NOTE: empirically, svelte replaces _children_ of itemdiv, so any attributes must be stored on children
    //       (otherwise changes to children, e.g. rendered math, can disappear and not get replaced)

    // insert right-floating div that keeps the item's text clear of .item-menu (the menu's height, and its
    // width less MENU_INDEX_PAD where the number comes first), which will also serve as first element of itemdiv
    // NOTE: this is a workaround for a null-parent exception if .item-menu is placed inside .item by Svelte
    // the div follows the digit count of the item's number (_digits): the menu is as wide as the
    // digits, and a re-ranked item's number gains or loses a digit without its children being replaced
    // (the room of the marks left of the number is this div's too, by css alone: its left margin is
    // the room of a mark of item code and its left padding that of the app's own marks, see THE
    // MARKS LEFT OF AN ITEM'S NUMBER in the style block. nothing of that is measured or set here)
    const digits = menuDigits(index)
    let div = itemdiv.firstElementChild as HTMLElement | null
    const inserted = div?.id == 'menu-' + id
    if (!inserted || div.getAttribute('_digits') != digits.toString()) {
      let menu = itemdiv.parentElement.querySelector('.item-menu')
      if (!inserted) div = document.createElement('div')
      // the menu's size is measured once per menu shape, digit count and zoom and reused (menuSize,
      // above): reading it here on every item render forced a synchronous layout per item — a third
      // of a second of the initial render at desktop speed on a 1600-item corpus (init_perf, 2026-09-07)
      const zoom = (itemdiv.closest('.items') as HTMLElement | null)?.style.zoom ?? ''
      const size = menuSize(menu, zoom, digits)
      const pad = menu.firstElementChild?.classList.contains('index') ? MENU_INDEX_PAD : 0 // see MENU_INDEX_PAD
      div.style.width = size.width - pad + 'px'
      div.style.height = size.height + 'px'
      div.setAttribute('_digits', digits.toString())
      if (!inserted) {
        /* -10px to remove .item padding, +1px for inset (when .bordered), +1px extra clearing space */
        div.style.marginTop = div.style.marginRight = '-8px'
        div.style.float = 'right'
        // div.style.background = "red";
        div.id = 'menu-' + id
        itemdiv.insertBefore(div, itemdiv.firstElementChild)
        // no placeholder: the item's children are new (the template replaces them all whenever
        // toHTML returns another string, and every such string carries its own cache key), so the
        // generated footer of that markup is not there yet. it goes in after the body as a
        // fragment of its own: the body's parse has ended and closed whatever it left open, so
        // the footer and the summaries are children of the item whatever the content holds
        if (footerHTML) itemdiv.insertAdjacentHTML('beforeend', footerHTML)
      }
    }

    // we highlight both primary and secondary matching terms
    const highlightTerms = matchingTerms + ' ' + matchingTermsSecondary
    const childHighlightKey =
      childHighlightSelected || childHighlightSecondary
        ? `${childHighlightSelected}|${childHighlightSecondary}`
        : ''

    // skip afterUpdate if hash, version, and highlightTerms are unchanged
    // note without version, highlights break after item.invalidate_elem_cache()
    if (
      hash == itemdiv.firstElementChild.getAttribute('_hash') &&
      version.toString() == itemdiv.firstElementChild.getAttribute('_version') &&
      highlightTerms == itemdiv.firstElementChild.getAttribute('_highlightTerms')
    ) {
      // child-only changes stay out of the full pass (which wraps link onclick handlers and sets up
      // DOM elements): only re-check repeated marks when selection flipped or inert frames populated,
      // and only toggle drawn highlight classes when childHighlightKey changed
      if (turned || framesPopulated) syncRepeatedChildTags()
      if (childHighlightKey != (itemdiv.firstElementChild.getAttribute('_childHighlight') ?? '')) {
        itemdiv.firstElementChild.setAttribute('_childHighlight', childHighlightKey)
        syncChildHighlights()
      }
      // console.debug("afterUpdate skipped");
      return
    }
    itemdiv.firstElementChild.setAttribute('_hash', hash)
    itemdiv.firstElementChild.setAttribute('_version', version.toString())
    itemdiv.firstElementChild.setAttribute('_highlightTerms', highlightTerms)
    itemdiv.firstElementChild.setAttribute('_childHighlight', childHighlightKey)
    // console.debug("afterUpdate", name);

    // cache/restore any cached elements with _cache_key (invoked again later for elements with scripts)
    cacheElems()

    // highlight matching tags using selected/secondary-selected classes
    const matchingTermSet = new Set<string>(matchingTerms.split(' ').filter(t => t))
    const matchingTermSecondarySet = new Set<string>(matchingTermsSecondary.split(' ').filter(t => t))
    itemdiv.querySelectorAll('mark:not(.child-tag)').forEach(mark => {
      const title = (mark.getAttribute('title') ?? '').toLowerCase()
      const selected = matchingTermSet.has(title)
      const secondary_selected = !selected && matchingTermSecondarySet.has(title)
      mark.classList.toggle('selected', selected)
      mark.classList.toggle('secondary-selected', secondary_selected)
    })
    syncRepeatedChildTags()
    syncChildHighlights()

    // highlight matching terms in item text
    const mindboxModifiedAtDispatch = window['_mindboxLastModified']
    const highlightDispatchIndex = highlightDispatchCount++
    // NOTE: because highlights can be out-of-order, we always highlight priority items
    const maxHighlightsPerTerm = aboveFold ? Infinity : Infinity // no limit for now

    // remove previous highlights or related elements
    itemdiv.querySelectorAll('span.highlight').forEach((span: HTMLElement) => {
      // span.replaceWith(span.firstChild); // seems to scale beter
      span.outerHTML = span.innerHTML
    })
    itemdiv.querySelectorAll('mark div').forEach(spacer => {
      spacer.remove()
    })
    itemdiv.querySelectorAll('mark.matching').forEach(mark => {
      mark.classList.remove('matching')
    })

    const highlightClosure = () => {
      if (highlightDispatchIndex != highlightDispatchCount - 1) return // cancelled due to other dispatch

      // if mindbox was modified AND debounced recently, also postpone highlights up to 500ms
      const timeSinceMindboxModified = Date.now() - window['_mindboxLastModified']
      if (timeSinceMindboxModified < 500 && window['_mindboxDebounced']) {
        setTimeout(highlightClosure, 500 - timeSinceMindboxModified)
        return
      }

      // show item again, but cancel highlights if itemdiv is missing or mindbox modified
      if (!itemdiv || window['_mindboxLastModified'] != mindboxModifiedAtDispatch) return

      let terms: string[] = highlightTerms.split(' ').filter(t => t)
      if (label) {
        // expand terms for shortening, mirroring "reltag" logic in toHTML
        // one difference here is that terms are lowercased so labelText is irrelevant
        // another difference is that we drop the '/' from the suffix tag for matching
        const parentLabel = label.replace(/\/[^\/]*$/, '')
        const grandParentLabel = label.replace(/\/[^\/]*?\/[^\/]*$/, '')
        terms.slice().forEach((term: string) => {
          if (term[0] != '#') return
          if (term.length > label.length && term[label.length] == '/' && term.substring(0, label.length) == label)
            terms.push('#' + term.substring(label.length + 1))
          else if (
            parentLabel &&
            term.length > parentLabel.length &&
            term != label &&
            term[parentLabel.length] == '/' &&
            term.substring(0, parentLabel.length) == parentLabel
          )
            terms.push('#' + term.substring(parentLabel.length + 1))
          else if (
            grandParentLabel &&
            term.length > grandParentLabel.length &&
            term != label &&
            term[grandParentLabel.length] == '/' &&
            term.substring(0, grandParentLabel.length) == grandParentLabel
          )
            terms.push('#' + term.substring(grandParentLabel.length + 1))
        })

        // apply any shortening (#…) on label to all highlight terms to ensure proper highlighting of label prefix
        // note we could recompute the shortening here but it is easier to just fetch the rendered label text
        // also note shortening of label can be based on contextLabel or a prefix matching term (see toHTML)
        let collapsed_prefix
        const rendered = (itemdiv.querySelector('mark.label') as HTMLElement)?.innerText
        if (rendered.startsWith('…')) {
          collapsed_prefix = label.substring(0, label.length - rendered.length + 1)
          terms = _.uniq([...terms, ...terms.map(term => term.replace(collapsed_prefix, '#…')), '#…'])
        }
        // console.debug(label, terms)
      }

      if (terms.length == 0) return
      let highlight_counts = window['_highlight_counts']

      let treeWalker = document.createTreeWalker(itemdiv, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: function (node) {
          const classList = (node as HTMLElement).classList
          switch (node.nodeName.toLowerCase()) {
            case 'mark':
              return classList?.contains('selected') || classList?.contains('secondary-selected')
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT
            case 'svg':
            case 'script':
            case 'style':
              return NodeFilter.FILTER_REJECT
            default:
              return classList?.contains('c3') ||
                classList?.contains('dot') ||
                classList?.contains('math') ||
                classList?.contains('math-display') ||
                classList?.contains('macro')
                ? // || classList?.contains("deps-and-dependents")
                  NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT
          }
        },
      })
      while (treeWalker.nextNode()) {
        const node = treeWalker.currentNode
        if (node.nodeType != Node.TEXT_NODE) continue
        const parent = node.parentNode
        let text = node.nodeValue
        terms = terms.filter(t => !(highlight_counts[t] >= maxHighlightsPerTerm))
        if (terms.length == 0) continue // nothing left to highlight
        terms.sort((a, b) => b.length - a.length) // longer first as needed for regex
        let regex = new RegExp(`^(.*?)(${terms.map(_.escapeRegExp).join('|')})`, 'si')
        // if we are highlighting inside tag, we expand the regex to allow shortening and rendering adjustments ...
        if (node.parentElement.tagName == 'MARK') {
          let tagTerms = terms
            // note #… is now added to terms above based on shortening applied to label
            // .concat(highlight_counts['#…'] + highlight_counts['…'] >= maxHighlightsPerTerm ? [] : ['#…'])
            .map(_.escapeRegExp)
          tagTerms = tagTerms.concat(tagTerms.map(t => t.replace(/^#(.+)$/, '^$1')))
          tagTerms.sort((a, b) => b.length - a.length) // longer first as needed for regex
          regex = new RegExp(`(^.*?)(${tagTerms.join('|')})`, 'si')
        }
        let m
        while ((m = text.match(regex))) {
          text = text.slice(m[0].length)
          const term = m[2].toLowerCase()
          const count = highlight_counts[term] || 0
          if (count >= maxHighlightsPerTerm) continue
          highlight_counts[term] = count + 1

          const tagText = node.parentElement?.tagName == 'MARK' ? node.parentElement?.innerText : ''
          parent.insertBefore(document.createTextNode(m[1]), node)
          let word = parent.insertBefore(document.createElement('span'), node)
          word.appendChild(document.createTextNode(m[2]))
          word.className = 'highlight'

          if (node.parentElement.tagName == 'MARK') {
            // ensure tag visible
            node.parentElement.classList.add('matching')
            // NOTE: this becomes stale when the match goes away
            // node.parentElement.style.background = "white";
            // adjust margin/padding and border radius for in-tag (in-mark) matches
            const tagStyle = getComputedStyle(node.parentElement)
            word.style.borderRadius = '0'

            // NOTE: marks (i.e. tags) can have varying vertical padding (e.g. under .menu class)
            word.style.paddingTop = tagStyle.paddingTop
            word.style.marginTop = '-' + word.style.paddingTop
            word.style.paddingBottom = tagStyle.paddingBottom
            word.style.marginBottom = '-' + word.style.paddingBottom
            // left/right margin matches span.highlight css
            // word.style.paddingLeft = word.style.paddingRight = "1px";
            // word.style.marginLeft = word.style.marginRight = "-1px";
            const prefixMatch = tagText.indexOf(m[2]) == 0 && node.parentElement.children.length == 1
            const suffixMatch = text.length == 0

            if (prefixMatch) {
              // prefix match (rounded on left)
              word.style.paddingLeft = tagStyle.paddingLeft
              word.style.marginLeft = '-' + tagStyle.paddingLeft
              word.style.borderTopLeftRadius
              word.style.borderTopLeftRadius = tagStyle.borderTopLeftRadius
              word.style.borderBottomLeftRadius = tagStyle.borderBottomLeftRadius

              // insert spacer divs under .menu class where non-hidden mark becomes flexible
              if (node.parentElement.closest('.menu') && !node.parentElement.classList.contains('hidden')) {
                let spacer = node.parentElement.insertBefore(
                  document.createElement('div'),
                  node.parentElement.firstChild
                )
                spacer.style.background = '#9b9' // .item mark span.highlight background
                spacer.style.height = '100%'
                spacer.style.flexGrow = '1'
                spacer.style.paddingLeft = tagStyle.paddingLeft
                spacer.style.paddingTop = tagStyle.paddingTop
                spacer.style.paddingBottom = tagStyle.paddingTop
                spacer.style.marginLeft = '-' + tagStyle.paddingLeft
                spacer.style.marginTop = '-' + tagStyle.paddingTop
                spacer.style.marginBottom = '-' + tagStyle.paddingTop
                spacer.style.borderTopLeftRadius = tagStyle.borderTopLeftRadius
                spacer.style.borderBottomLeftRadius = tagStyle.borderBottomLeftRadius
                if (!suffixMatch) {
                  let rightSpacer = node.parentElement.appendChild(document.createElement('div'))
                  rightSpacer.classList.add('spacer')
                }
              }
            }
            if (suffixMatch) {
              // suffix match (rounded on right)
              word.style.paddingRight = tagStyle.paddingRight
              word.style.marginRight = '-' + tagStyle.paddingRight
              word.style.borderTopRightRadius = tagStyle.borderTopLeftRadius
              word.style.borderBottomRightRadius = tagStyle.borderBottomLeftRadius

              // insert spacer divs under .menu class where mark becomes flexible
              if (node.parentElement.closest('.menu')) {
                let spacer = node.parentElement.appendChild(document.createElement('div'))
                spacer.style.background = '#9b9' // .item mark span.highlight background
                spacer.style.height = '100%'
                spacer.style.flexGrow = '1'
                spacer.style.paddingRight = tagStyle.paddingRight
                spacer.style.paddingTop = tagStyle.paddingTop
                spacer.style.paddingBottom = tagStyle.paddingTop
                spacer.style.marginRight = '-' + tagStyle.paddingRight
                spacer.style.marginTop = '-' + tagStyle.paddingTop
                spacer.style.marginBottom = '-' + tagStyle.paddingTop
                spacer.style.borderTopRightRadius = tagStyle.borderTopRightRadius
                spacer.style.borderBottomRightRadius = tagStyle.borderBottomRightRadius
                if (!prefixMatch) {
                  let leftSpacer = node.parentElement.insertBefore(
                    document.createElement('div'),
                    node.parentElement.firstChild
                  )
                  leftSpacer.classList.add('spacer')
                }
              }
            }
          }
        }
        node.nodeValue = text
      }
    }
    // if (aboveFold) highlightClosure();
    // else setTimeout(highlightClosure);
    setTimeout(highlightClosure)

    // indicate errors/warnings and context/target items
    // NOTE: .error and .warning classes can be used to trigger a visual indication of errors/warnings, but ranking is handled separately in index.svelte (in onEditorChange) and uses a separate hasError flag computed there
    error = !!itemdiv.querySelector('.console-error,.macro-error,mark.missing,.error')
    // the console explanation of that border, deduped per item (src/item_errors.ts): the
    // rendered causes, incl. the macro errors the expansion deliberately does not log
    logItemErrors(id, name, collectItemErrorSources(itemdiv))
    warning = !!itemdiv.querySelector('.console-warn,.warning')

    // trigger typesetting of any math elements
    // NOTE: we do this async to see if we can load MathJax async in template.html
    setTimeout(() => {
      if (!itemdiv) return
      let math = []
      itemdiv.querySelectorAll('span.math,span.math-display').forEach(elem => {
        if (elem.hasAttribute('_rendered')) return
        // a span already typeset whose mark is pending (handed back by the element cache to a re-render while its
        // job was still running, see renderMath) is rendered: never delimiters around its output (the owner,
        // 2026-10-05: inline math shown between `$$`)
        if (elem.querySelector('mjx-container')) return void elem.setAttribute('_rendered', Date.now().toString())
        // console.debug("rendering math", elem.innerHTML);
        // unwrap code blocks (should exist for both $``$ and $$``$$)
        let code
        if ((code = elem.querySelector('code'))) code.outerHTML = code.innerHTML
        // insert delimiters if missing (in particular for multi-line _math blocks)
        if (!elem.textContent.match(/^\$.+\$$/)) elem.innerHTML = '$$' + '\n' + elem.innerHTML + '\n' + '$$'
        math.push(elem)
      })
      renderMath(math, () => {
        math.forEach(elem => {
          // console.debug("rendered math", elem.innerHTML)
          // a span renderMath marked failed keeps that mark (a frame's typeset that failed: its TeX is text)
          if (!elem.hasAttribute('_rendered')) elem.setAttribute('_rendered', Date.now().toString())
        })
      })
    })

    // linkify urls & tags in code comments (regexes from util.js, labeling logic from replaceURLs in toHTML)
    // the comments are html-escaped (highlight.js output), so we use the escaped-html rule
    const host_base = location.host
    const link_urls = text =>
      text.replace(urlRegExp({ escaped: true }), (m, pfx, href) => {
        // the match is escaped html (its `&amp;` is the escaped `&`): the real url for parsing
        let { host, pathname, search, hash } = new URL(_.unescape(href))
        // drop suffix of host shared with host_base
        for (let i = 0; i < host.length; i++) {
          if (host_base.endsWith(host.substring(i))) {
            host = host.substring(0, i)
            break
          }
        }
        if (pathname == '/') pathname = ''
        if (!pathname && !host) host = host_base // do not allow empty host + path
        let label = host + ((pathname + search + hash).length > 1 ? '/…' : '')
        if (window['_shortcut_hosts']?.includes(host)) label = host + pathname + (search + hash ? '/…' : '')
        // NOTE: no inline handler. HTML escaping does not protect an event-handler attribute,
        // which is compiled AFTER character references are decoded, so an owner url containing a
        // quote used to close the javascript string and run its own expression on click. the
        // anchor carries data only; its listener is attached from the DOM below (linkifyComments).
        // the href is interpolated as it stands: it is already escaped html (a quote or `<` in it
        // arrives as an entity, which ends the url), and escaping it again wrote `&amp;amp;` into
        // href and title, so hover, copy-link and open-in-new-tab carried `amp;b` for `b`. the label
        // is the other way round: derived from the PARSED url, it is plain text (a shortcut host's
        // label carries the path), so it is escaped once here (2026-09-21)
        return (
          `${pfx}<a href="${href}" target="_blank" rel="noopener noreferrer" ` +
          `title="${href}" data-link-click>${_.escape(label)}</a>`
        )
      })
    const link_tags = text =>
      text.replace(/(^|\s|\()(#[^#\s<>&,.;:!"'`(){}\[\]]+)/g, (m, pfx, tag) => {
        const tag_resolved = window['_resolve_tag'](label, tag) ?? tag
        // same reasoning as link_urls: data only, listener attached from the DOM below
        return `${pfx}<a href="#" title="${_.escape(tag_resolved)}" data-tag-click="${_.escape(tag_resolved)}">${tag}</a>`
      })
    itemdiv.querySelectorAll('.hljs-comment').forEach(comments => {
        comments.innerHTML = link_tags(link_urls(comments.innerHTML))
        // attach listeners from the DOM: the anchors above carry data attributes only, so no
        // owner-controlled value is ever compiled as javascript
        comments.querySelectorAll('a[data-link-click]').forEach((a: any) => {
          // the handler unescapes its href once; the DOM attribute is the real url, so it is
          // escaped once on the way in and a url whose text carries a literal `&amp;` reaches
          // the app as written (2026-09-21, the anchor's own escaping used to compensate)
          a.onclick = e => window['_handleLinkClick'](id, _.escape(a.getAttribute('href')), e)
        })
        comments.querySelectorAll('a[data-tag-click]').forEach((a: any) => {
          const tag = a.getAttribute('data-tag-click')
          a.onmousedown = e => window['_handleTagClick'](id, tag, tag, e)
          a.onclick = e => {
            e.preventDefault()
            e.stopPropagation()
          }
        })
      })

    // add click handler to links w/ custom onclick that does not trigger _handleLinkClick
    itemdiv.querySelectorAll('a').forEach(a => {
      if (!a.getAttribute('onclick')) return
      if (a.getAttribute('onclick').includes('_handleLinkClick')) return
      const prevOnClick: any = a.onclick
      a.onclick = function (e) {
        let ret
        if (prevOnClick) ret = prevOnClick(e)
        try {
          window['_handleLinkClick'](id, a.href, e)
        } catch (e) {
          console.error(e)
        }
        return ret // preserve return value to avoid confusion
      }
    })

    // wiki links (src/wiki_links.ts; design wiki_links 2.4): the anchor carries data only; its
    // click stops at the anchor and soft-touches the item like any link click, and its default
    // action stays, so the browser navigates in place and hands the url to the editor with no
    // tab in between (a target would leave an empty tab behind); the inert frames' anchors are
    // covered too (populated at the top of this update)
    itemdiv.querySelectorAll('a[data-wiki-link]').forEach((a: any) => {
      a.onclick = e => {
        window['_handleLinkClick'](id, _.escape(a.getAttribute('href')), e)
        // the anchor keeps no focus: the owner saw a bright border on a clicked link now and
        // then (2026-09-27); no app style draws one, so by inference it is the browser's focus
        // ring on the anchor, shown when the window comes back from the editor application
        a.blur()
      }
    })

    // invoke global function _highlight (if it exists) w/ elements of class _highlight_*
    // NOTE: _* suffix is added by highlight.js dependening on scope depth
    if (window['_highlight']) {
      itemdiv.querySelectorAll('._highlight,._highlight_,._highlight__,._highlight___').forEach(elem => {
        try {
          window['_highlight'](elem, id)
        } catch (e) {
          console.error('error in window._highlight:', e)
        }
      })
    }

    // render images currently on item (dynamically added images may be rendered via _render_images)
    renderImages(id, itemdiv.querySelectorAll('img'))

    // turn un-typed inputs into multiple file inputs
    itemdiv.querySelectorAll('input:not([type])').forEach((input: HTMLInputElement) => {
      input.type = 'file'
      input.multiple = true
    })

    // set up markdown-generated checkboxes
    itemdiv.querySelectorAll('li span.list-item input[type=checkbox]').forEach((elem: HTMLElement) => {
      const li = elem.closest('li')
      if (!li) return // should not happen but just in case
      if (!elem.hasAttribute('_checkbox_index')) return // element not parsed properly
      const index = parseInt(elem.getAttribute('_checkbox_index'))
      // remove "disabled" attribute added by markdown
      elem.removeAttribute('disabled')
      // add .checkbox(.checked) class to containing list item
      li.classList.add('checkbox')
      if (elem.hasAttribute('checked')) li.classList.add('checked')
      // configure click handler
      elem.onclick = e => {
        e.stopPropagation()
        e.preventDefault()
        let item = window['_item'](id)
        // alert("checkbox index " + index + " on item " + item.name);
        // read-modify-write over the GRAMMAR VIEW then restore raw envelopes (review
        // 148 §2): reading item.read() (grammar view) and writing it back would persist
        // opaque markers, and a fake checkbox inside a candidate would shift the index
        const text = editInertText(item.text, grammar => {
          let checkboxIndex = 0
          return grammar.replace(/(?:^|\n)\s*(?:\d+\.|[-*+]) \[[xX ]\] /g, m => {
            if (checkboxIndex++ == index) return m.replace(/\[[xX ]\]/, elem.hasAttribute('checked') ? '[ ]' : '[x]')
            else return m
          })
        })
        item.write(text, '' /* replace whole item*/)
      }
    })

    // add .checbox class to unordered lists where all items are checkbox items
    itemdiv.querySelectorAll('ul').forEach((ul: HTMLElement) => {
      if (ul.querySelector(':scope > li:not(.checkbox)')) return
      ul.classList.add('checkbox')
    })

    // set up file inputs to insert images into item
    // NOTE: only the first file input is accepted and replaces all inputs
    itemdiv.querySelectorAll('input[type=file]').forEach((input: HTMLInputElement) => {
      input.accept = 'image/*,application/pdf' // accept only images
      input.onchange = function (e: InputEvent) {
        const modal = window['_modal']('Inserting selected images ...')
        let total_size = 0
        Promise.all(
          Array.from(input.files).map(file =>
            Promise.resolve(
              onPastedImage(URL.createObjectURL(file), file, size => {
                total_size += size
                window['_modal_update'](
                  `Inserting selected images (${numberWithCommas(Math.ceil(total_size / 1024))} KB) ...`
                )
              })
            )
          )
        )
          .then((fnames: any) => {
            setTimeout(() => window['_modal_close'](modal), 0) // increase delay for testing
            const zoom = Math.round(1000 / devicePixelRatio) / 1000
            const images = fnames
              .map(fname => {
                return zoom == 1.0 ? `<img src="${fname}">` : `<img src="${fname}" style="zoom:${zoom}">`
              })
              .join('\n')
            let item = window['_item'](id)
            // grammar-view edit + raw restore (review 148 §2): a fake file input inside
            // a candidate must not be a replacement target
            const text = editInertText(item.text, grammar =>
              grammar.replace(/<input\s(?:"[^"]*"|[^>"])*?type\s*=\s*["']?file(?:"[^"]*"|[^>"])*>|<input>/gi, images)
            )
            item.write(text, '' /* replace whole item*/)
          })
          .catch(console.error)
      }
    })

    // hide/remove all whitespace in tail of .content
    // note this is a dynamic fallback for the static removal in toHTML
    // static is preferred since dynamic changes can cause flicker when item is updated
    // for (const node of Array.from(itemdiv.querySelector('.content').childNodes).reverse()) {
    //   if (node.nodeType == Node.TEXT_NODE && !node.textContent.trim()) node.remove()
    //   else if (node.nodeType == Node.ELEMENT_NODE) {
    //     const elem = node as HTMLElement
    //     if (elem.tagName == 'BR') elem.remove()
    //     else if (elem.tagName == 'PRE' && elem.children[0]?.className == '_log') continue // hidden/toggled logs
    //     else if (elem.tagName == 'MARK' && elem.classList.contains('hidden')) continue // hidden tag
    //     else if (_.every(elem.childNodes, (c:any) =>
    //         (c.nodeType == Node.TEXT_NODE && !c.textContent.trim()) || c.tagName == 'BR' || (c.tagName == 'MARK' && c.classList.contains('hidden'))
    //       )) elem.style.display = 'none'
    //     else {
    //       // remove all whitespace in tail of last element
    //       while (elem.lastChild &&
    //         ((elem.lastChild.nodeType == Node.TEXT_NODE && !elem.lastChild.textContent.trim()) ||
    //          (elem.lastChild.nodeType == Node.ELEMENT_NODE && (elem.lastChild as HTMLElement).tagName == 'BR')))
    //         elem.removeChild(elem.lastChild)
    //       break
    //     }
    //   }
    //   else break
    // }

    // in fixed/shared mode, hide the last visible tag (<mark>) inside last visible <p> if followed by only whitespace or hidden tags and if the tag refers to another visible shared item on the page
    if (fixed) {
      const last_tag = _.last(
        Array.from(
          _.findLast(
            itemdiv.querySelectorAll('.item .content > p'),
            p => getComputedStyle(p).display != 'none'
          )?.querySelectorAll(':scope > mark:not(.hidden)')
        )
      ) as HTMLElement
      if (last_tag && window['_item'](last_tag.title, { silent: true })?.shared?.indices) {
        let siblings = []
        let elem = last_tag
        while ((elem = elem.nextSibling as HTMLElement)) siblings.push(elem)
        if (
          siblings.every(
            s => (s.nodeType == Node.TEXT_NODE && !s.textContent.trim()) || s.tagName == 'BR' || s.tagName == 'MARK'
          )
        )
          last_tag.style.display = 'none'
      }
    }

    // trigger execution of script tags by adding/removing them to <head>
    // NOTE: this is slow, so we do it asyc, and we warn if the parent element is not cached
    setTimeout(() => {
      if (!itemdiv) return
      const scripts = itemdiv.querySelectorAll('script')
      // wait for all scripts to be done, then update height in case it changes
      if (scripts.length == 0) return

      // invalidate cache whenever scripts are run (same as in onDone and onRun)
      // since dependencies are not always fully captured in the cache key (even with deephash)
      // NOTE: no version increment here, even for entries left live by the invalidation (unlike
      // invalidate_elem_cache in index.svelte): restoring cached elements and then invalidating
      // is the NORMAL flow for items with cached content, and since cacheElems re-caches after
      // every successful script pass, any forced re-render restores again and loops; the live
      // restored element is tolerated by design until the next natural re-render (the deleted
      // cache entry guarantees that render regenerates it)
      invalidateElemCache(id)

      let pendingScripts = scripts.length
      let scriptErrors = []
      // console.debug(`executing ${pendingScripts} scripts in item ${name} ...`);
      scripts.forEach(async (script, scriptIndex) => {
        // console.debug(script.parentElement);
        if (!script.hasAttribute('_uncached') && !script.closest('[_cache_key]')) {
          console.warn('uncached script will execute at every render (missing _cache_key on/above element)')
        }

        // NOTE: we do not support .src yet, when we do we need to fetch the script using AJAX, prefix w/ __id, and ensure proper completion/error handling via script.onerror assuming that works.
        if (script.hasAttribute('src')) {
          console.error('script src not supported yet')
        } else {
          const item = window['_item'](id)
          try {
            const js = script.innerHTML.replace(/<br>\n/g, '\n').trim() // trim any <br>\n inserted in markdown scope
            await item.eval(js, {
              trigger: 'script_' + scriptIndex,
              // if _exclude_async, then code from local item is excluded if deepasync
              // (note code from deepasync deps are already excluded for sync eval)
              exclude_async: script.hasAttribute('_exclude_async'),
              async: script.hasAttribute('_async'),
              async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
              // NOTE: writing/logging to item from an (uncached) script tag can trigger a dangerous
              // write->render->write loop regardless of whether the script is _async or not
              read_only: true, // make lexical _this read-only to block simple unintentional writes
            })
          } catch (e) {
            console.error(`<script> error in item ${name}: ${e}`)
            scriptErrors.push(e)
          }
        }

        script.remove() // remove script to indicate execution
        pendingScripts--
        if (pendingScripts > 0) return
        // console.debug(`all scripts done in item ${name}`);
        setTimeout(() => onResized(id, container, 'scripts done'), 0)
        // if no errors, cache elems with _cache_key that had scripts in them
        if (scriptErrors.length == 0) cacheElems()

        // scripts that render dot graphs should invoke window._dot_rendered, defined below
        // scripts that dynamically add/manipulate images should invoke window._render_images, defined below
      })
    })
  })

  onDestroy(() => {
    reapRetiredElems(id, { force: true }) // expired-while-live elements lose their dom with this component
    // delete only our own entry: during a column move a NEW instance for the same id can install
    // its hooks before this old instance is destroyed, and must not lose them here
    if (window['_item_hooks']?.[id] === itemHooks) delete window['_item_hooks'][id]
    // move cached elements into dom to prevent offloading by browser
    window['_elem_cache'][id]?.forEach(adoptCachedElem)
  })

  // per-item hooks registry: the window globals below are installed once (??=) and so must not
  // use any component instance's closures — they would belong to whichever item mounted first and
  // misattribute measurements, caching and invalidations to it; instead they route through this
  // registry by the PASSED item's id
  const itemHooks = {
    resize: (trigger: string) => {
      if (trigger == 'toggle') syncRepeatedChildTags()
      onResized(id, container, trigger)
    },
    render_images: (elems: NodeListOf<Element>) => renderImages(id, elems),
    running_mark: showOnRunningMark, // the item's status and its run's progress have changed (index.svelte, itemShowStatus)
  }
  ;((window['_item_hooks'] ??= {}) as any)[id] = itemHooks
  window['_render_images'] ??= item =>
    window['_item_hooks']?.[item.id]?.render_images(item.elem?.querySelectorAll('.item > .content img') ?? [])
  window['_dot_rendered'] ??= function (item, dot) {
    // render "stack" clusters (subgraphs)
    dot.querySelectorAll('.cluster.stack').forEach(cluster => {
      let path = cluster.children[1] // first child is title
      ;(path as HTMLElement).setAttribute('fill', '#111')
      let path2 = path.cloneNode()
      ;(path2 as HTMLElement).setAttribute('transform', 'translate(-3,3)')
      ;(path2 as HTMLElement).setAttribute('opacity', '0.75')
      cluster.insertBefore(path2, path)
      let path3 = path.cloneNode()
      ;(path3 as HTMLElement).setAttribute('transform', 'translate(-6,6)')
      ;(path3 as HTMLElement).setAttribute('opacity', '0.5')
      cluster.insertBefore(path3, path2)
    })

    // render math in text nodes
    let math = []
    dot.querySelectorAll('text').forEach(text => {
      if (text.textContent.match(/^\$.+\$$/)) {
        text['_bbox'] = (text as SVGGraphicsElement).getBBox() // needed below
        math.push(text)
      }
    })
    if (math.length == 0) return
    // typesets are serialized on the shared queue (see renderMath), but the completion work here
    // must use the PASSED item, not this closure's component (see the ??= note above)
    window['_typeset_queue'] = (window['_typeset_queue'] ?? Promise.resolve())
      .then(() => window['MathJax'].startup.promise) // the page's automatic scan is off (src/app.html): wait for the startup, as renderMath does
      .then(() => window['MathJax'].typesetPromise(math))
      .then(function () {
        const itemdiv = math[0].closest('.item')
        // NOTE: inTabOrder: false option updates context menu but fails to set tabindex to -1 so we do it here
        itemdiv?.querySelectorAll('.MathJax').forEach(elem => elem.setAttribute('tabindex', '-1'))
        dot.querySelectorAll('.node > text > .MathJax > svg').forEach(mathsvg => {
          if (!item.elem?.contains(mathsvg)) {
            // console.error("detached _graph elem in item", item.name)
            item.invalidate_elem_cache?.()
            return
          }
        // the typeset svg holds the math in a <g>, preceded by its glyph <defs> under fontCache
        // 'local' (see app.html); both move into the graph node so the <use> refs keep resolving
        let math = mathsvg.querySelector(':scope > g') as SVGGraphicsElement
        let defs = mathsvg.querySelector(':scope > defs')
        let dot = mathsvg.parentNode.parentNode.parentNode
        // NOTE: node can have multiple shapes as children, e.g. doublecircle nodes have two
        let shape = dot.children[1] as SVGGraphicsElement // shape (e.g. ellipse) is second child
        let text = dot.children[dot.children.length - 1] // text is last child
        let shaperect = shape.getBBox()
        let textrect = text['_bbox'] // recover text bbox pre-mathjax
        let textscale = textrect.height / shaperect.height // fontsize-based scaling factor
        mathsvg.parentElement.parentElement.remove() // remove text node
        if (defs) dot.appendChild(defs)
        dot.appendChild(math)
        let mathrect = math.getBBox()
        let scale = (0.6 * textscale * shaperect.height) / mathrect.height
        let xt0 = -mathrect.x
        let yt0 = -mathrect.y
          let xt = shaperect.x + shaperect.width / 2 - (mathrect.width * scale) / 2
          let yt = shaperect.y + shaperect.height / 2 + (mathrect.height * scale) / 2
          math.setAttribute('transform', `translate(${xt},${yt}) scale(${scale},-${scale}) translate(${xt0},${yt0})`)
        })
        window['_item_hooks']?.[item.id]?.resize('math rendered')
      })
      .catch(console.error)
  }
</script>

<div
  class="super-container"
  id={'super-container-' + id}
  class:editing
  class:hidden
  class:target
  class:target_context
  class:pushable
  class:previewable
  class:timed={timeString.length > 0}
>
  {#if timeString}
    <div
      class="time"
      class:timeOutOfOrder
      title={new Date(time)
        .toLocaleString(navigator.language, {
          weekday: 'short',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
        })
        .replace(/,/g, ' ')}
    >
      {timeString}
    </div>
  {/if}
  {#if showDebugString}
    <div class="debug">{debugString}</div>
  {/if}
  <div
    bind:this={container}
    on:pointerover={onPointerOver}
    on:mousedown={onMouseDown}
    on:click={onClick}
    class="container"
    class:hideLabel
    class:editing
    class:focused
    class:saving
    class:error={error || failedTests}
    class:warning
    class:target
    class:target_context
    class:running
    class:admin
    class:showLogs
    class:bordered={error || failedTests || warning || target}
    class:editable
    class:pushable
    class:previewable
    class:runnable
    class:saveable
    class:timeOutOfOrder
    data-item-id={id}
  >
    {#if editing}
      <div class="edit-menu">
        {#if runnable}
          <div class="button run" on:click={onRunClick}>run</div>
        {/if}
        {#if editable}
          <div class="button save" on:click={onSaveClick}>save</div>
        {/if}
        {#if pushable}
          <div class="button push" on:click={onPushClick}>
            <img src="/arrow.up.svg" alt="push" title="push" />
            <!-- <span class="optional-label">push</span> -->
          </div>
        {/if}
        {#if source && labelUnique}
          <div class="button update" on:click={onUpdateClick}>
            <img src="/arrow.down.svg" alt="update" title="update" />
            <!-- <span class="optional-label">update</span> -->
          </div>
        {/if}
        {#if source}
          <div class="button source" on:click={onSourceClick}>
            <img src="/external-link.svg" alt={path} title={path} />
            <span class="optional-label">{path}</span>
          </div>
        {/if}
        {#if editable}
          <div class="button image" on:click={onImageClick}>
            <img src="/photo.fill.svg" alt="+img" title="+img" />
            <!-- <span class="optional-label">img</span> -->
          </div>
        {/if}
        <div class="button cancel" on:click={onCancelClick}>close</div>
        {#if !fixed}
          <div class="button delete" on:click={onDeleteClick}>delete</div>
        {/if}
        {#if running}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="running-mark" class:noted={runningNote} use:runningMark on:mousedown|preventDefault on:click={onRunningMarkClick}></div>
        {/if}
      </div>

      <Editor
        id_suffix={id}
        bind:this={editor}
        bind:text
        bind:editorText
        bind:focused
        bind:selectionStart
        bind:selectionEnd
        resume={resumeEditor}
        cancelOnDelete={fixed}
        onRun={() => onRun(index, null, undefined, true) /* the editor's own key: a run from this item's editor */}
        {onSave}
        {onPrev}
        {onNext}
        onFocused={focused => onFocused(focused ? index : -1, focused)}
        onEdited={text => onEdited(index, text)}
        {onEditorKeyDown}
        {onEscape}
        {onPastedImage}
        {onDone}
        {editable}
      />
    {:else}
      <div class="item-menu">
        {#if runnable}
          <div class="button run" on:click={onRunClick}>run</div>
        {/if}
        <!-- (the running mark comes after the digits, which stay the number's first child, and is shown before them by its order; its clicks are told from the number's in onIndexClick) -->
        <div class="button index" class:leader class:matching class:reserved={menuDigits(index) > 0} style:--index-digits={menuDigits(index)} on:click={onIndexClick}>
          {index + 1}{#if running}<span class="running-mark" class:noted={runningNote} use:runningMark></span>{/if}
        </div>
        <!-- (the state circles: the menu's last child, shown before the number by its order. no listener of their own: their presses and clicks are told from the item's by these two elements, see ownStateMark) -->
        {#if pushable || previewable}
          <div class="state-marks">{#if previewable}<span class="state-mark previewable-mark" bind:this={previewableMark}></span>{/if}{#if pushable}<span class="state-mark pushable-mark" bind:this={pushableMark}></span>{/if}</div>
        {/if}
      </div>
      <!-- NOTE: id for .item can be used to style specific items using #$id selector -->
      <!-- capturing `toggle` listener (native `toggle` does not bubble) re-syncs drawn child tags when a `<details>` inside the item opens or closes -->
      <div id={'item-' + id} class="item {styleDepsString}" bind:this={itemdiv} class:saving class:headerMinimal class:fixed on:toggle|capture={syncRepeatedChildTags}>
        <!-- NOTE: arguments to toHTML (e.g. deephash) determine dependencies for (re)rendering -->
        {@html toHTML(
          text || placeholder,
          id,
          deephash,
          labelUnique,
          contextLabel,
          missingTags,
          danglingTags,
          matchingTerms,
          matchingTermsSecondary,
          depsString,
          dependentsString,
          version,
          childrenString
        )}
      </div>
    {/if}
    <div class="loading">
      {#if saving}
        <Circle size="25" unit="px" />
      {/if}
    </div>
  </div>
</div>

<style>
  .super-container {
    position: relative;
    padding: 4px 0;
    padding-left: 1px; /* avoid touching window border, looks better on the mac */
    pointer-events: none; /* pointer events are left to .container */
  }
  .super-container.editing:not(.timed) {
    padding-top: 24px; /* extra space for .edit-menu */
  }
  .hidden {
    position: absolute;
    left: -100000px;
    width: 100%;
  }

  .container {
    position: relative;
    border-radius: 5px; /* aligns with editor radius (4px) 1px inside */
    background: #111;
    border: 1px solid transparent; /* transparent = same as background */
    box-sizing: border-box;
    pointer-events: all;
  }
  .admin {
    border: 1px dashed #444;
  }
  .item-menu {
    display: flex;
    position: absolute;
    top: -1px;
    right: -1px;
    /* background: #333; */
    opacity: 1;
    /* NOTE: border-radius causes pixel alignment issues on right edge, so we add rounding to menu items */
    /* border-radius: 0 5px 0 4px; */
    /* overflow: hidden; */
    color: black;
    font-size: 15px;
    font-weight: 600;
    /* outer border causes odd cutoff on right side, so we cut off at the buttons */
    /* border-radius: 5px; */
    /* overflow: hidden; */
    box-sizing: border-box;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .button {
    background: #999;
    display: inline-flex;
    cursor: pointer;
    align-items: center;
    border-right: 1px solid black;
    height: 25px;
    padding: 0 8px;
  }
  .button:first-child {
    border-top-left-radius: 5px;
    border-bottom-left-radius: 5px;
  }
  .button:last-child {
    border-top-right-radius: 5px;
    border-bottom-right-radius: 5px;
  }

  .button img {
    width: 20px;
    height: 20px;
    min-width: 20px; /* necessary on smaller device */
    vertical-align: middle;
    filter: invert(100%);
  }

  /* adjust img style for external-link.svg icon, pre-inverted and padded 2px */
  .button.source img {
    filter: none;
    width: 22px;
    height: 22px;
    margin: -2px;
  }

  /* adjust img style for photo.svg icon, which has some vertical padding */
  .button.image img {
    margin: -2px 0;
    opacity: 0.75; /* lighten photo background */
  }

  /* use smaller push icon, full-height arrow feels too much */
  .button.push img {
    width: 18px;
    height: 18px;
  }
  .button.push {
    background: #f84;
  }

  /* use smaller update/pull icon, full-height arrow feels too much */
  .button.update img {
    width: 18px;
    height: 18px;
  }

  .optional-label {
    margin-left: 2px;
  }

  .bordered .item-menu {
    top: 0;
    right: 0;
  }
  .item-menu > .button:first-child {
    border-top-left-radius: 0;
  }
  .item-menu > .button:last-child {
    border-bottom-right-radius: 0;
  }
  .bordered .item-menu > .button:last-child {
    border-top-right-radius: 4px;
  }

  .edit-menu {
    display: flex;
    position: absolute;
    top: -20px;
    right: -1px;
    z-index: 2;
    /* see comment above about issues with border-radius */
    /* border-radius: 4px 6px 4px 4px; */
    /* overflow: hidden; */
    opacity: 1;
    color: black;
    font-size: 15px;
    font-weight: 600;
    box-sizing: border-box;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }

  .index {
    padding: 0 4px;
    border: 0;
  }

  .index.matching {
    background: #9f9;
  }
  .delete {
    /* color: #900; */
    background: #b66;
    /* padding-left: 15px; */
  }
  .save {
    background: #7a7;
  }
  .container:not(.saveable) .save,
  .saving .save {
    background: #444;
    cursor: not-allowed;
  }
  .run {
    /* color: #0b0; */
    background: #4ae;
  }
  .container:not(.runnable) .run {
    display: none;
  }
  .runnable.running .run,
  .runnable.saving .run {
    background: #444;
    cursor: not-allowed;
  }

  .item-menu > .index {
    background: transparent;
    color: #777;
  }

  /* a number of at most MENU_INDEX_DIGITS digits (see the module script): a fixed width, not a
     minimum, of one ch a digit (--index-digits, set with the number), so the menu is as wide as
     the digit count makes it in any font and no room is kept beside the digits (ch follows the
     font in use; tabular digits fit it exactly where the font has them); the number keeps its
     place at the right */
  .item-menu > .index.reserved {
    width: calc(var(--index-digits) * 1ch);
    justify-content: flex-end;
    font-variant-numeric: tabular-nums;
  }

  .item-menu > .index.leader {
    color: #eee;
  }

  .item-menu > .index.matching {
    color: #9f9;
  }

  .item-menu > .run {
    border-bottom-right-radius: 5px;
  }

  /* THE MARKS LEFT OF AN ITEM'S NUMBER, and the one place that says how much room each takes: a
     custom property per mark on the item's box.
       --running-mark-room       the app's running mark (the ring, below): 18px while the item runs
       --pushable-mark-room      the app's circle of an item that can be pushed (THE STATE CIRCLES,
                                 below): --state-mark-room while it can
       --previewable-mark-room   the same for an item that can be previewed
       --item-mark-room          a mark that item code draws (the #vault item's watched sparkle,
                                 mind.items vault.md, vault_watched_css): the item's stylesheet
                                 sets it on the boxes it marks; unset, no room
     --state-mark-room is the room of one state circle where it is drawn: 18px by the number, as
     the ring's there (15px and 3px to what follows), and 29px in the edit menu, as the ring's 23px
     and 6px there.
     the room left free is their sum: the item's text keeps out of it (the placeholder for the menu,
     the first child of the text: afterUpdate) and a run button steps aside by it. no mark takes
     room of the menu itself, whose size is measured once for all items of a shape (menuSize): a
     mark is drawn outside the number's box, and a run button is moved without the menu resizing.
     the sum is applied as two terms, each through a property of its own (the placeholder's margin
     and padding, the run button's offset and translation), so that an older #vault item, whose
     stylesheet sets that margin and that offset itself (18px, until 2026-11-18) and so replaces
     the item's term, still adds up with the app's marks.
     THE ORDER, from the left: the ring, the circle of an item that can be previewed, the circle of
     one that can be pushed, a mark of item code, the number. the longer a mark stays, the nearer
     the number it stands: the sparkles of watched items keep their column beside the digits
     whatever comes and goes, and a run begins and ends at the outer end. a mark that comes moves
     what stands left of it: a circle that appears during a run moves the still-running ring left
     by its room, and a run button steps left by the room of every mark.
     the means: a mark of item code is the `::before` of the number and stands nearest it, the
     running mark is an element after the digits, moved to the front of the number's line (order),
     left of it, and the state circles are one box, the last child of the MENU, moved in the
     menu's line to right before the number's box (THE STATE CIRCLES, below): it steps left by the room the item's
     mark SAYS (--item-mark-room), and the ring steps left of it by the circles' rooms, by its
     margins (a translate would make the ring the containing block of its note).
     a mark of item code takes no room in the number's line by a negative margin of its own. where
     the number's box has a fixed width (.reserved: up to four digits) the mark is given its real
     room in the line while the item runs, which is what puts the ring left of it without the app
     knowing its size, also for an older #vault item that says no room (!important: the item's
     own rule is as specific as this one). a longer number's box is as wide as its content, and
     the menu with it: there no mark may take room in the line (the menu grew by the mark's 18px
     when the run began, and the run button moved twice as far as the text's placeholder), so
     both keep their negative margins and the ring steps left by the room the item's mark SAYS
     (--item-mark-room; an older item says none, and on such a number its sparkle and the ring
     share their place). the state circles are in the menu's line, not the number's, so they have
     the said room alone on every number: beside an older item's sparkle a circle shares the
     sparkle's place */
  .container {
    --state-mark-room: 18px;
    --running-mark-room: 0px;
    --pushable-mark-room: 0px;
    --previewable-mark-room: 0px;
  }
  .container.editing {
    --state-mark-room: 29px;
  }
  .container.running {
    --running-mark-room: 18px;
  }
  .container.pushable {
    --pushable-mark-room: var(--state-mark-room);
  }
  .container.previewable {
    --previewable-mark-room: var(--state-mark-room);
  }
  .item > :global([id^='menu-']:first-child) {
    margin-left: var(--item-mark-room, 0px);
    padding-left: calc(var(--running-mark-room) + var(--pushable-mark-room) + var(--previewable-mark-room));
  }
  .item-menu > .run {
    position: relative;
    right: var(--item-mark-room, 0px);
    translate: calc(-1 * (var(--running-mark-room) + var(--pushable-mark-room) + var(--previewable-mark-room))) 0;
  }
  .container.running .item-menu > .index.reserved::before {
    margin-left: 0 !important;
  }
  .item-menu > .index:not(.reserved) > .running-mark {
    translate: calc(-1 * var(--item-mark-room, 0px)) 0;
  }

  /* THE RUNNING MARK: a small ring in the blue that the running border had, a quarter of it bright
     and turning; the one thing a running item shows. it is an element of its own while the item
     runs (.running-mark: it has a tooltip, the item's status, and takes a tap, see
     onRunningMarkClick), and the ring is that element's ::before. by the number it is as large as
     the watched sparkle (15px, and 3px to the digits or to the mark before them: its 18px) and
     stands WHERE THE SPARKLE STANDS: the element is a line of the number's own font, centred in
     the number's box as the digits' line is, and the ring an inline box on that line's baseline,
     lowered by whole pixels (2px, as the sparkle's image: mind.items vault.md, vault_watched_css).
     the browser rounds a text's baseline and a box's edge to the pixel grid separately: a ring
     centred in the number's box, as it was until 2026-11-19, stood a pixel above the digits and
     the sparkle on an item at a whole-pixel position and in line with them only on an item in
     the lower half of a pixel (by pixels, in Open Sans at 1x and 2x). in the editor, where no
     number shows, it is the first thing in the edit menu, left of a mark of item code and of the
     buttons (the menu's LAST child, shown first by its order), centred on the buttons and a
     little less than their height (23px, as the sparkle there) */
  .running-mark {
    order: -1;
    flex: none;
    cursor: default;
  }
  .running-mark::before {
    content: '';
    box-sizing: border-box;
    border: var(--running-mark-stroke) solid rgba(68, 170, 255, 0.3);
    border-top-color: #4af;
    border-radius: 50%;
    animation: running-mark 1s linear infinite;
  }
  .item-menu > .index > .running-mark {
    --running-mark-stroke: 2px;
    margin: 0 3px 0 calc(-1 * var(--running-mark-room));
  }
  .item-menu > .index > .running-mark::before {
    display: inline-block;
    position: relative;
    top: 2px;
    width: calc(var(--running-mark-room) - 3px);
    height: calc(var(--running-mark-room) - 3px);
  }
  .edit-menu > .running-mark {
    --running-mark-stroke: 3px;
    align-self: center;
    width: 23px;
    height: 23px;
    margin-right: 6px;
  }
  .edit-menu > .running-mark::before {
    display: block;
    height: 100%;
  }
  /* (the edit menu's last button keeps its corners: the mark after it takes :last-child from it) */
  .edit-menu > .button:has(+ .running-mark) {
    border-top-right-radius: 5px;
    border-bottom-right-radius: 5px;
  }
  /* A PROGRESS FILLS THE RING (_Item's progress, index.svelte: above 0 and up to 1): it stands
     still and is bright from the top clockwise as far as the progress says (--running-mark-fill,
     set with .filled by writeRunningMark), a full ring at 1. the stroke is the ring's own: the
     gradient under a border that keeps its width, cut to it by the mask. without a progress, or
     at 0, it turns */
  .running-mark:global(.filled)::before {
    border-color: transparent;
    background: conic-gradient(#4af var(--running-mark-fill), rgba(68, 170, 255, 0.3) 0) border-box;
    --running-mark-hole: calc(100% - var(--running-mark-stroke));
    -webkit-mask: radial-gradient(closest-side, transparent calc(var(--running-mark-hole) - 0.25px), #000 calc(var(--running-mark-hole) + 0.25px));
    mask: radial-gradient(closest-side, transparent calc(var(--running-mark-hole) - 0.25px), #000 calc(var(--running-mark-hole) + 0.25px));
    animation: none;
  }
  /* THE NOTE of a tap on the mark where no pointer hovers (.noted, onRunningMarkClick): the
     mark's tooltip, read off its title, in a small box under the menu (neither the mark nor the
     number is positioned: the box is placed in the menu), at the item's right edge by the number
     and under the mark in the editor, where the menu is as wide as the note may get. (on a number
     beyond four digits the mark carries a translate, above, and that makes the mark itself the
     box's containing block, also at an offset of zero: there the note's right edge is the ring's) */
  .running-mark.noted::after {
    content: attr(title);
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 3;
    box-sizing: border-box;
    width: max-content;
    max-width: 240px;
    padding: 4px 8px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #222;
    color: #ccc;
    font-size: 13px;
    font-weight: 400;
    line-height: 1.3;
    text-align: left;
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
  .edit-menu > .running-mark.noted::after {
    right: auto;
    left: 0;
    max-width: 100%;
  }
  @keyframes running-mark {
    to {
      transform: rotate(360deg);
    }
  }

  /* THE STATE CIRCLES: an item that can be pushed, and one that can be previewed, each a ring of
     the running mark's size and stroke in the colour its border had (#a52, #c7c; the border goes),
     standing still: a state, where the ring that turns is an activity.
     BY THE NUMBER EACH IS A MOUSE'S CONTROL (2026-11-19; the script, at onMouseDown): under a
     mouse's pointer the hand and the tooltip `push` or `preview`, and a mouse's click that pushes
     the item as the edit menu's push button does, or previews it, and is the circle's alone, with
     the focus where it was. so each is an element of its own there (a tooltip is an element's,
     and the two were one pseudo-element), with no listener of its own.
     FOR A FINGER AND A PEN it is what it was, no control: a press on a circle is the item's (its
     default is not prevented, as the ring's is), and its click the item's (it previews an item
     that can be previewed and edits any other). measured in a phone's window with the MindBox
     focused, beside a plain item whose text stood at that point: a tap is the number's, as it
     was, and the one tap that reaches a circle, on the previewable one of an item in both states,
     is the item's: it previews and takes the focus (tests/e2e/layout.spec.ts). until 2026-11-19 a
     press was the item's for every pointer, and a click there opened the editor, which took the
     focus.
     a press at that point is not what it was where a control stood there: the run button and the
     ring move left by the circles' room, so a click where the run button ended (4px before the
     digits) now reaches the circle, and on a running item without a sparkle the pushable circle
     stands where the ring stood. an item can be in both states (a preview's file changed again
     before its push): the previewable circle stands left of the pushable one. each is an image of
     18px by 15px whose circle is its right 15px (3px to the left of it), --pushable-mark and
     --previewable-mark.
     IN THE EDITOR they are as they were, a picture and no control: the push button stands beside
     them there */
  .container.pushable {
    --pushable-mark: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='15' viewBox='-3 0 18 15'%3E%3Ccircle cx='7.5' cy='7.5' r='6.5' fill='none' stroke='%23a52' stroke-width='2'/%3E%3C/svg%3E");
  }
  .container.previewable {
    --previewable-mark: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='15' viewBox='-3 0 18 15'%3E%3Ccircle cx='7.5' cy='7.5' r='6.5' fill='none' stroke='%23c7c' stroke-width='2'/%3E%3C/svg%3E");
  }
  /* by the number they stand WHERE THE RING AND THE SPARKLE STAND: one box (.state-marks; the
     number's own ::before is a mark of item code's, and a click on the number's box would be the
     number's), a line of the number's own font (the menu's, which the number inherits) centred in
     the menu's line, which is the number's box (25px from the menu's top), and the circles boxes
     of their images' size on that line's baseline (.state-mark: an inline box without a line of
     its own stands on the baseline with its lower edge, as an image does), lowered by whole
     pixels (2px), as the sparkle's image and the ring's inline box are. the box stands in the
     menu's line between a run button and the number's box and takes no room there (its margins):
     it ends 1px inside the number's box, where the digits' padding leaves 3px to them
     (MENU_INDEX_PAD). it is the menu's LAST child, shown there by its order, as the ring is the
     number's: the menu's first child is still the button that says how wide the text's
     placeholder is (afterUpdate), and a run button is still the first of its line.
     (until 2026-11-19 the box was the menu's ::before and the circles its content, two images:
     the same box, line and place) */
  .container:is(.pushable, .previewable) .item-menu > .run {
    order: -1;
  }
  .item-menu > .state-marks {
    order: -1;
    flex: none;
    align-self: center;
    position: relative;
    top: 2px;
    margin: 0 -1px 0 calc(1px - var(--pushable-mark-room) - var(--previewable-mark-room));
    translate: calc(-1 * var(--item-mark-room, 0px)) 0;
  }
  .state-mark {
    display: inline-block;
    width: 18px;
    height: 15px;
    background: no-repeat;
  }
  .pushable-mark {
    background-image: var(--pushable-mark);
  }
  .previewable-mark {
    background-image: var(--previewable-mark);
  }
  /* the hand, under a mouse's pointer (.moused, written by onPointerOver in the script: a class,
     since a stylesheet cannot ask which pointer hovers). no :hover or :active rule on a circle:
     see TOUCH TARGETING there */
  .state-mark:global(.moused) {
    cursor: pointer;
  }
  /* (the number keeps the corner it has as the menu's last button: the circles' box after it
     takes :last-child from it. its box is transparent, so this is a matter of what a press at
     that corner hits) */
  .item-menu > .button:has(+ .state-marks) {
    border-top-right-radius: 5px;
  }
  .bordered .item-menu > .button:has(+ .state-marks) {
    border-top-right-radius: 4px;
  }
  /* and the ring left of them, by its margins (the same room in the number's line, moved) */
  .container:is(.pushable, .previewable) .item-menu > .index > .running-mark {
    margin-left: calc(-1 * (var(--running-mark-room) + var(--pushable-mark-room) + var(--previewable-mark-room)));
    margin-right: calc(3px + var(--pushable-mark-room) + var(--previewable-mark-room));
  }
  /* in the editor, where no number shows: the edit menu's ::after (its ::before is a mark of item
     code's, and the ring an element), shown after the ring and before the rest by its order,
     centred on the buttons as the ring and the sparkle are, each circle 23px and 6px before the next */
  .container:is(.pushable, .previewable) .edit-menu::after {
    content: '';
    order: -1;
    flex: none;
    align-self: center;
    width: calc(var(--pushable-mark-room) + var(--previewable-mark-room) - 6px);
    height: 23px;
    margin-right: 6px;
    background:
      var(--pushable-mark, none) right center / auto 23px no-repeat,
      var(--previewable-mark, none) right var(--pushable-mark-room) center / auto 23px no-repeat;
  }

  .time {
    height: 20px; /* fixed height (=24 including margin-bottom) */
    color: #444;
    display: inline-block;
    padding-left: 5px;
    padding-right: 5px;
    margin-bottom: 4px;
    font-size: 15px;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
    pointer-events: all;
  }
  .time.timeOutOfOrder {
    color: #aaa;
    /* background: #111; */
    /* color: black; */
    border-radius: 4px;
    /* display: block; */
  }
  .debug {
    display: inline-block;
    /* display: none; */
    color: #444;
  }
  .item {
    color: #ddd;
    width: 100%;
    min-height: 48px; /* single line height */
    padding: 10px;
    box-sizing: border-box;
    /* white-space: pre-wrap; */
    word-wrap: break-word;
    font-size: 17px;
    line-height: 30px;
    /* cursor: pointer; */
    /* clear floats (e.g. deps, dependents) */
    /* this causes scrolling for popups */
    /* overflow: auto; */
  }

  /* NOTE: if you add/remove border types here, need to also update class:bordered={...} above*/
  .target {
    border-color: #242;
  }
  .target_context {
    border-left-color: #242;
  }
  .target_context {
    border-radius: 0 5px 5px 0;
  }
  .target_context.editing {
    border-radius: 5px;
  }
  .warning {
    border-color: #663;
  }
  .error {
    border-color: #633;
  }
  .editing {
    border-color: transparent; /* border is visible but NOT updated while editing, so we hide for now */
  }

  /* .item.saving {
    opacity: 0.5;
  } */

  .loading {
    display: flex;
    flex-direction: column;
    visibility: hidden;
    position: absolute;
    z-index: 1;
    padding: 1px;
    top: -1px;
    left: -1px;
    width: 100%;
    height: 100%;
    justify-content: center;
    align-items: center;
    background: rgba(0, 0, 0, 0.5);
    pointer-events: none; /* passthrough */
  }
  .loading > :global(div) {
    opacity: 0.75;
    min-height: var(--size); /* prevent distortion when the indicator exceeds item height */
  }
  /* the overlay is the SAVING item's alone: a running item is not dimmed (see the running mark) */
  .saving .loading {
    visibility: visible;
  }

  /* :global prevents unused css errors and allows matches to elements from other components (see https://svelte.dev/docs#style) */
  .item > :global(.content :is(h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, pre)) {
    margin: 0;
  }
  .item > :global(.content :is(h1, h2, h3, h4, h5, h6)) {
    margin-bottom: 5px;
  }
  .item > :global(.content :is(ul, ol)) {
    padding-left: 20px;
    color: #999;
  }
  /* .item > :global(.content :is(ul,ol) > *) {
    margin-left: 20px;
  } */
  .item > :global(.content span.list-item) {
    color: #ddd;
    display: block;
    padding-left: 5px; /* some internal padding in case list-item given background/border/etc */
    margin-left: -5px; /* negate internal padding to avoid increasing bullet gap */
  }

  /* safari-only styles to fix bullet gap behavior, see https://stackoverflow.com/a/25975282 for safari selector */
  :global(_::-webkit-full-page-media),
  :global(_:future),
  :global(:root) .item > :global(.content span.list-item) {
    display: inline-block; /* fix safari treatment of negative margin pushing bullets out instead of reducing gap */
    vertical-align: top; /* fix default baseline alignment of bullets for inline-block */
    /* -4px is better for ul, -5px better for ol, must be consistent w/ padding-left set below */
    margin-left: -9px; /* extra -4px to reduce bullet gap in safari */
    /* text-indent: -4px; */ /* alternative to reduce bullet gap in safari */
  }
  :global(_::-webkit-full-page-media),
  :global(_:future),
  :global(:root) .item > :global(.content :is(ul, ol)) {
    padding-left: 24px; /* compensate for negative margin on .list-item to reduce bullet gap in Safari */
  }

  /* additional space between list items */
  .item > :global(.content :is(ul, ol) > li:not(:last-of-type)) {
    padding-bottom: 2px;
  }
  /* reduced space between nested list items */
  .item > :global(.content :is(ul, ol) > li :is(ul, ol) > li:not(:last-of-type)) {
    padding-bottom: 1px;
  }
  /* additional space below nested lists for inner list items */
  .item > :global(.content li:not(:last-of-type) > :is(ul, ol)) {
    padding-bottom: 2px;
  }
  /* add some space before/after lists for more even spacing with surrounding text */
  .item > :global(.content > :is(ul, ol):not(:first-child)) {
    padding-top: 2px;
  }
  .item > :global(.content > :is(ul, ol):not(:last-child)) {
    padding-bottom: 2px;
  }
  /* avoid breaking list items in multi-column items */
  /* NOTE: this turns out to be too performance-intensive and can make columns difficult to balance out */
  /* .item > :global(.content li) {
    break-inside: avoid;
  } */

  /* style markdown-generated checkboxes */
  /* custom styling css adapted from https://www.sliderrevolution.com/resources/css-checkbox/ */
  .item > :global(.content span.list-item input[type='checkbox']) {
    vertical-align: middle;
    /* pointer-events: none; */
  }
  .item > :global(.content :is(li.checkbox.checked, li.checkbox.checked li)) {
    /* text-decoration: line-through; */
    opacity: 0.5;
    /* display: none; */
  }
  .item > :global(.content ul.checkbox) {
    list-style: none;
  }
  .item > :global(.content ul.checkbox > li > span.list-item > p > input[type='checkbox']) {
    margin-left: -15px;
  }
  .item > :global(.content ul.checkbox > li > span.list-item > input[type='checkbox']) {
    margin-left: -15px;
  }
  .item > :global(.content input[type='checkbox']) {
    -webkit-appearance: none;
    appearance: none;
    border: 1px solid #aaa;
    border-radius: 4px;
    cursor: pointer;
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .item > :global(.content input[type='checkbox']:checked) {
    /* the mark: the check mark U+2713 (with U+FE0E), bold, 15px, in the text's own color,
       shifted up one pixel to sit centered in the box (the owner's choice, 2026-09-15, over
       the heavy check mark in white, which rendered tinted on their devices); the glyph still
       comes from whichever installed font has it (the item's font does not) */
    color: #ddd;
    font-family: 'Open Sans', system-ui, sans-serif;
    font-weight: 700;
    font-size: 15px;
    line-height: 1;
  }
  /* --tick is defined in src/app.html so the built stylesheet stays pure ASCII: a raw character
     in it (what the minifier writes for CSS escapes, without @charset) has shown as garbled bytes
     on the owner's pages */
  .item > :global(.content input[type='checkbox']:checked:after) {
    content: var(--tick);
    transform: translateY(-1px);
  }
  /* the inert tree's task rows (vault design mind_task_agents 9.6): a passive box styled like
     the checkbox above, monochrome, the same size ticked or not */
  .item > :global(.content span.task) {
    box-sizing: border-box; /* the input's default: 20px with its border */
    border: 1px solid #aaa;
    border-radius: 4px;
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
    color: #ddd; /* the mark as the checkbox above draws it */
    font-family: 'Open Sans', system-ui, sans-serif;
    font-weight: 700;
    font-size: 15px;
    line-height: 1;
  }
  .item > :global(.content span.task.checked:after) {
    content: var(--tick);
    transform: translateY(-1px);
  }
  /* an unticked passive box fades like a ticked row does (above), the box alone, so the
     inert tree's boxes read as passive either way, unlike the app's own checkboxes outside
     inert sections, which stay live controls at full strength (the owner, 2026-09-15);
     inside a ticked row the row's fade already applies */
  .item > :global(.content span.task:not(.checked)) {
    opacity: 0.5;
  }
  .item > :global(.content li.checkbox.checked span.task) {
    opacity: 1;
  }
  .item > :global(.content ul.checkbox > li > span.list-item > span.task),
  .item > :global(.content ul.checkbox > li > span.list-item > p > span.task) {
    margin-left: -15px;
  }

  /* use default top-alignment & column-spacing and for tables */
  .item > :global(.content table) {
    border-spacing: 0;
  }
  .item > :global(.content table :is(td, th)) {
    padding: 1px 5px;
  }
  .item > :global(.content table :is(td, th)) {
    vertical-align: top;
  }

  /* NOTE: blockquotes (>...) are not monospaced and can keep .item font*/
  .item > :global(.content blockquote) {
    padding-left: 5px;
    margin-top: 5px;
    border-left: 1px solid #333;
  }
  /* NOTE: these font sizes should match those in Editor */
  .item > :global(.content pre) {
    /* padding-left: 5px; */
    /* margin-top: 5px; */
    /* border-left: 1px solid #333; */
    font-size: 14px;
    line-height: 24px;
    margin-top: 4px;
  }
  .item > :global(.content pre:first-child) {
    margin-top: 0;
  }
  .item > :global(.content code) {
    font-size: 14px;
    line-height: 24px;
    font-family: 'JetBrains Mono', monospace;
    font-weight: 300;
    white-space: pre-wrap; /* preserve whitespace */
    background: rgba(255, 255, 255, 0.075); /* transparency allows shading of background */
    padding: 2px 4px;
    border-radius: 4px;
    hyphens: auto; /* inline code can get long and cause undesirable wrapping */
    hyphenate-character: '-'; /* '' is same as word-break:all */
  }
  .item > :global(.content a code) {
    background: none;
    /* vertical-align: text-top; */ /* center-aligns in parent (a) background */
  }
  .item > :global(.content pre > code) {
    background: none;
    border-radius: 0;
    display: block;
    /* background: #171717; */
    /* border-radius: 4px; */
    padding: 2px 5px;
    margin: -2px -5px;
    border-left: 1px solid #333;
    hyphens: none; /* disable in multi-line code blocks (vs inline code) */
  }
  .item > :global(.content a) {
    color: #79e;
    background: rgba(255, 255, 255, 0.075); /* transparency allows shading of background */
    /* 1px bottom padding ~matches inline-block visually while allowing inline treatment, e.g. for ellipses */
    /* but 0 bottom padding is consistent w/ .item mark, so we go w/ that for now ... */
    padding: 0 4px;
    border-radius: 4px;
    text-decoration: none;
    line-height: 24px;
    hyphens: auto; /* url links can get long and cause undesirable wrapping */
    hyphenate-character: '-'; /* '' is same as word-break:all */
  }
  .item > :global(:is(.content, .child-tags, .deps-and-dependents) mark) {
    color: black;
    background: #999;
    font-weight: 600;
    padding: 0 4px;
    margin: 0;
    border-radius: 4px;
    cursor: pointer;
  }
  /* drawn child tags: 85% of a written tag's size, inline beside a bare label or in a block below;
     line-height: normal keeps the smaller inline box inside the 30px strut so the name's line does not grow */
  .item > :global(:is(.content, .child-tags) mark.child-tag) {
    font-size: 85%;
    line-height: normal;
  }
  /* they stand back from what the owner wrote, at half alpha (the owner, 2026-11-23); the ones on
     the selected path stay fully lit */
  .item > :global(:is(.content, .child-tags) mark.child-tag:not(.selected, .secondary-selected)) {
    opacity: 0.5;
  }
  .item > :global(:is(.content, .child-tags) mark.child-tag.repeated),
  .item > :global(:is(.content, .child-tags) .child-tags.empty),
  .item > :global(.child-tags.empty) {
    display: none;
  }
  /* drawn child tags on a line of their own below an item with content other than its label, at
     the right */
  .item > :global(.child-tags) {
    clear: both;
    text-align: right;
  }
  /* beside a bare label: at the right end of the label's line. The label's own paragraph holds
     the float (a flow root), so tags that wrap push what follows down: an opened log starts below
     them and takes no click of theirs (review 5 of the thread child_tags). The float is no wider
     than that paragraph, so one name longer than the line wraps inside the item and does not
     leave its start past the left edge (review 6). That line ends at the item's number, so the
     tags stand off it by the item's own padding, as the label stands off the left edge (the
     owner, 2026-11-24); the margin comes out of the float's width, not on top of it */
  .item > :global(.content span.child-tags) {
    float: right;
    margin-right: 10px;
    max-width: calc(100% - 10px);
    text-align: right;
  }
  .item > :global(.content p:has(> span.child-tags)) {
    display: flow-root;
  }
  .item > :global(.content:has(> :is(ul, ol, pre, table, blockquote):last-child) + .child-tags) {
    margin-top: 2px;
  }

  /* .menu styling: paragraphs become flex boxes */
  .item > :global(.menu p) {
    display: flex;
    line-height: 24px; /* same as .menu img below */
    width: 96%; /* align right side while leaving space for item number and tapping for editing */
  }
  .item > :global(.menu a),
  .item > :global(.menu mark:not(.hidden, .child-tag)) {
    padding: 4px;
    font-size: 110%;
    font-weight: 600;
  }
  .item > :global(.menu p a),
  .item > :global(.menu p mark:not(.hidden, .child-tag)) {
    flex: 1 1 auto;
    display: flex;
    justify-content: center;
    align-items: center;
    margin: 2px;
  }
  .item > :global(.menu img) {
    width: 24px;
    height: 24px;
    min-width: 24px; /* necessary on smaller device */
    vertical-align: middle;
  }

  .item > :global(:is(.content, .deps-and-dependents) mark.label) {
    background: #ddd;
  }
  .container.hideLabel .item > :global(:is(.content, .deps-and-dependents) mark.label) {
    display: none !important;
  }
  .item > :global(:is(.content, .deps-and-dependents) mark.label.unique) {
    font-weight: 700;
  }
  .item > :global(:is(.content, .deps-and-dependents) mark.missing) {
    background: #f88;
  }
  /* a relative tag no item carries (the owner, 2026-10-03): the token as written, styled like inline code,
     faded, a dim dashed border, not clickable; the error border is mark.missing's alone */
  .item > :global(:is(.content, .deps-and-dependents) mark.dangling) {
    color: #888;
    background: rgba(255, 255, 255, 0.05);
    border: 1px dashed #555;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 300;
    padding: 1px 4px;
    cursor: text;
  }
  /* a tag written in an inert section (src/inert_markdown.ts) is a quiet link that searches for it: the
     item's inline code, by its element, in a bluish tint (the owner, 2026-11-20); no underline. in a
     frame alone: an element of that class in the owner's own text is the owner's, and the closed
     line's copy of one (src/inert_blocks.ts, statusLine) is no link there and has no tint, which
     "would suggest a click would follow the link" (the owner): the plain inline code look */
  .item > :global(.content .vault-result code.tag-link),
  .item:not(.fixed) > :global(.content .vault-result code.command-link) {
    color: #9bf;
    background: rgba(102, 153, 255, 0.15);
    cursor: pointer;
  }
  /* in the closed line a tag or command link is a piece of that one line: it does not wrap (inline code
     may, and the line would spill out of its block), and it takes no height of its own (no vertical
     padding, its own font's line), so the line and its text stand exactly where they stand without it */
  .item > :global(.content .inert-status code:is(.tag-link, .command-link)) {
    white-space: nowrap;
    line-height: normal;
    padding-top: 0;
    padding-bottom: 0;
  }
  .item > :global(:is(.content, .child-tags, .deps-and-dependents) mark.selected) {
    background: #9f9;
  }
  .item > :global(:is(.content, .child-tags, .deps-and-dependents) mark.secondary-selected) {
    background: #9b9;
  }

  .item > :global(:is(.content, .deps-and-dependents) mark.hidden) {
    color: #ddd;
    background: #222;
    border: 1px dashed #ddd;
  }
  /* .item > :global(:is(.content, .deps-and-dependents) mark.hidden:not(.matching, .missing, .selected, .secondary-selected)) { */
  .item > :global(:is(.content, .deps-and-dependents) mark.hidden:not(.missing)) {
    display: none;
  }
  /* hide tags more aggressively in menu items */
  .item > :global(.menu mark.hidden:not(.missing/*, .selected*/)) {
    display: none;
  }

  /* disable <br> added by marked as last child under <p> in menu items */
  .item > :global(.menu p > br:last-child) {
    display: none;
  }
  /* the inert dead frame is a block inside the paragraph flow: the <br> the newline after
     it produces only adds an empty line (a rule needs none: it ends its paragraph). only that
     break: a blank line after the frame is the line pass's spacer (&nbsp;<br>, the SECOND br),
     which stays; blank lines INSIDE the frame are the inert markdown's own spacer paragraphs.
     the same after the block around a frame or a run of frames (.inert-block, below) */
  .item > :global(.content :is(.vault-result, .inert-block) + br) {
    display: none;
  }

  .item > :global(:is(.content, .deps-and-dependents) mark.hidden.missing) {
    border-color: #f88;
  }
  .item > :global(:is(.content, .deps-and-dependents) mark.hidden.selected) {
    border-color: #9f9;
  }
  .item > :global(:is(.content, .deps-and-dependents) mark.hidden.secondary-selected) {
    border-color: #9b9;
  }

  .item > :global(.content span.highlight) {
    /* note advantage of background highlighting is that border highlights can be cut off by overflow:hidden */
    /* we also avoid any changes that can shift text, e.g. font-weight changes */
    color: black;
    /* background: #9f9; */
    background: rgba(153, 255, 153, 0.5);
    /* font-weight: 600; */
    border-radius: 4px;
    /* border: 1px solid #9b9; */
    /* margin: -1px; */
  }
  .item > :global(:is(.content, .deps-and-dependents) mark.label.unique span.highlight) {
    font-weight: 700; /* match weight of mark.label.unique */
  }

  .item > :global(:is(.content, .child-tags, .deps-and-dependents) mark span.highlight) {
    color: black;
    background: #9b9;
    border: 0;
    margin: 0;
  }
  .item > :global(:is(.content, .deps-and-dependents) mark.label span.highlight) {
    background: #9f9;
  }

  .item > :global(:is(.content, .deps-and-dependents) mark .spacer) {
    flex-grow: 1;
  }
  /* disable spacers inside .menu highlights when prefix and suffix matches coincide */
  .item > :global(.menu mark .spacer:nth-last-of-type(4)),
  .item > :global(.menu mark .spacer:nth-last-child(2)) {
    display: none;
  }

  .item > :global(.content .vertical-bar) {
    color: #444;
  }
  .item > :global(.content :is(span.math, span.math-display)) {
    display: inline-block;
  }
  /* display top-level .math-display as block */
  /* .item > :global(.content > span.math-display) {
    display: block;
  } */
  .item > :global(.content hr) {
    background: transparent;
    border: 0;
    border-top: 1px dashed #333;
    height: 1px;
    margin: 0 -10px; /* extend out to edges of item */
    margin-top: 10px;
    margin-bottom: 9px; /* 1px less to center top border */
    clear: both; /* clear floats on both sides by default */
  }
  .item > :global(.content img) {
    max-width: 100%;
    max-height: 100%;
    min-width: 0; /* enable images to shrink, e.g. in a flex row */
    vertical-align: middle;
  }
  .item > :global(.content .vault-result) {
    white-space: normal; /* the inert markdown carries its own structure (pre-wrap for the invalid placeholder is moot) */
    overflow-wrap: anywhere;
    /* the DEAD FRAME (reviews 177-178; inert markdown since 2026-09-05): visibly inert -- a
       quiet frame around the inert-policy markdown of a canonical body, or the placeholder text.
       (since 2026-11-19 a canonical body's frame is always in a block, below, which takes the
       padding, the thick left border and the background away: this look is the invalid
       placeholder's, left as it was) */
    display: block;
    padding: 4px 8px;
    border-left: 2px solid #555;
    border-radius: 2px;
    background: rgba(128, 128, 128, 0.08);
  }
  /* THE INERT SECTIONS (src/inert_blocks.ts; the owner, 2026-11-19 and 2026-11-20): a frame, or
     the frames that follow each other, in ONE block under one head line (.inert-line: the first
     section's small name, on the middle of the line, and its status line). CLOSED, the block is
     that line and is exactly as tall as a line of the item's text at every width (its margins,
     its rules and a head of the item's line height less those 6px): a long status line is cut at
     the block's width with an ellipsis, on a phone too. OPEN, it is a full-width block in
     the look of the #template item's toggle() (dashed rules above and below, across the item's
     own padding where the block stands in the item's top-level flow), the sections under their
     small names; the frames are not framed again. An open block starts with its first section:
     with that section's name, 6px under the rule, or, where it has none (a reply), with the
     section's own first line, the item's own padding under the rule (the head holds the name
     alone then, and an empty head has no height). THE WHOLE BLOCK IS THE CONTROL (the pointer; a
     click anywhere on it toggles), and no arrow says so: the dashed look does. its marker, the
     control of a keyboard and a reader, lies over the block, takes no press, and shows as a ring
     under a keyboard's focus alone.
     OPEN is: what a manual toggle left (.opened, .closed) while it stands, else a search match
     (.matched), else the item being the target (blockOpen in the module is this same rule, and so is
     what a marker says of its block). the two classes of a toggle and the search's are the
     module's; the target is this component's own class, so a selection opens and closes the
     blocks by css */
  /* (span.: over the rules below that take the margins of every first and last child) */
  .item > :global(.content span.inert-block) {
    display: block;
    position: relative; /* the marker's containing block */
    white-space: normal;
    margin: 2px 0;
    padding: 0 6px;
    border: 1px dashed #444;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.075); /* transparency allows nesting, as toggle()'s */
    cursor: pointer;
  }
  .item > :global(.content .inert-block > .inert-line) {
    display: flex;
    align-items: center; /* the small name on the middle of the status line's text, not on its baseline */
    gap: 6px;
    line-height: calc(1lh - 6px); /* of the block's line height, which is the item's */
    height: 1lh;
  }
  /* the marker: the block's disclosure control for a keyboard (a button by its role, focusable).
     it lies over the whole block, out of the head's flow, shows nothing and takes no press (a
     press there is the block's); its ring, just inside the block's rules, shows for a keyboard's
     focus alone */
  .item > :global(.content .inert-block > .inert-line > .inert-toggle) {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .item > :global(.content .inert-block > .inert-line > .inert-toggle:focus-visible) {
    outline: 1px solid #888;
    outline-offset: -1px;
    border-radius: 3px;
  }
  .item > :global(.content .inert-block .inert-name) {
    flex: none;
    color: #888;
    font-size: 12px;
    line-height: 16px;
  }
  .item > :global(.content .inert-block .inert-status) {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item > :global(.content .inert-block > .vault-result) {
    display: none;
    padding: 0;
    border-left: 0;
    background: none;
  }
  .item > :global(.content .inert-block > .vault-result > .inert-name) {
    display: block;
  }
  /* (the first section's name is shown by the head) */
  .item > :global(.content .inert-block > .inert-line + .vault-result > .inert-name) {
    display: none;
  }
  .item > :global(.content .inert-block > .vault-result + .vault-result) {
    margin-top: 10px;
  }
  .item > :global(.content :is(.inert-block:is(.opened, .matched:not(.closed)), .container.target .inert-block:not(.closed))) {
    margin: 5px 0;
    padding: 10px; /* the item's own, above a reply's first line too */
    border-width: 1px 0;
    border-radius: 0;
    background: rgba(255, 255, 255, 0.05);
  }
  .item > :global(.content > p > :is(.inert-block:is(.opened, .matched:not(.closed)), .container.target .inert-block:not(.closed))) {
    margin: 5px -10px;
  }
  .item > :global(.content :is(.inert-block:is(.opened, .matched:not(.closed)), .container.target .inert-block:not(.closed)) > .inert-line) {
    height: auto; /* the name's line, or nothing */
    line-height: 16px;
  }
  /* (the name stands 4px into the block's padding, 6px under the rule, with 2px under it) */
  .item > :global(.content :is(.inert-block:is(.opened, .matched:not(.closed)), .container.target .inert-block:not(.closed)) > .inert-line > .inert-name) {
    margin: -4px 0 2px;
  }
  .item > :global(.content :is(.inert-block:is(.opened, .matched:not(.closed)), .container.target .inert-block:not(.closed)) > .inert-line > .inert-status) {
    display: none;
  }
  .item > :global(.content :is(.inert-block:is(.opened, .matched:not(.closed)), .container.target .inert-block:not(.closed)) > .vault-result) {
    display: block;
  }
  /* set default size/padding of pending images */
  .item > :global(.content img[_pending]) {
    width: 128px;
    height: 48px;
    border-radius: 4px;
    /* background: linear-gradient(150deg, #999 0%, #171717 100%); */
    /* shimmer animation */
    animation: shimmer 14s linear infinite;
    background: linear-gradient(-70deg, #171717 10%, #999 50%, #171717 90%);
    background-size: 1000% 100%;
  }
  /* failed images (download given up, see onImageFailed): keep the placeholder box visible,
     without the shimmer, so the failure has a visible footprint instead of an invisible pixel */
  .item > :global(.content img[_failed]:not([_pending])) {
    width: 128px;
    height: 48px;
    border-radius: 4px;
    animation: none;
    background: #411;
    border: 1px dashed #944;
  }
  @keyframes shimmer {
    0% {
      background-position: 500% 0;
    }
    100% {
      background-position: -500% 0;
    }
  }
  .item > :global(.content :first-child) {
    margin-top: 0;
  }
  .item > :global(.content :last-child) {
    margin-bottom: 0;
  }

  .item > :global(.content code._log) {
    display: none; /* toggled via .showLogs class */
    opacity: 0.75;
    font-size: 80%;
    line-height: 160%;
  }
  /* style logs highlighted in util.js, matching console colors in Index.svelte */
  .item > :global(.content code._log .console-debug),
  .item > :global(.log-summary .console-debug) {
    color: #666;
  }
  .item > :global(.content code._log .console-info),
  .item > :global(.log-summary .console-info) {
    color: #777;
  }
  .item > :global(.content code._log .console-log),
  .item > :global(.log-summary .console-log) {
    color: #999;
  }
  .item > :global(.content code._log .console-warn),
  .item > :global(.log-summary .console-warn) {
    color: yellow;
  }
  .item > :global(.content code._log .console-error),
  .item > :global(.log-summary .console-error) {
    color: #f55;
  }
  /* simplify linkified urls in log messages (e.g. in stack traces) and code comments */
  .item > :global(.content code._log a),
  .item > :global(.content .hljs-comment a) {
    color: #468;
    background: transparent;
    padding: 0;
    line-height: 100%;
  }
  .container.showLogs .item > :global(.content code._log),
  .container.showLogs .item > :global(.log-summary > .log-triangle) {
    display: block;
  }
  .container.showLogs .item > :global(.log-summary > .log-dot) {
    display: none;
  }
  .item > :global(.content code:empty) {
    display: block;
    border: 1px dashed #444;
    color: #444;
    padding: 0 4px;
    border-radius: 4px;
  }

  .item > :global(.content code:empty:before) {
    content: 'empty ' attr(class);
  }

  .item > :global(:is(.log-summary, .deps-summary, .dependents-summary)) {
    display: flex;
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    font-weight: 300;
    align-items: bottom;
    justify-content: center;
    /* background: red; */
    min-width: 100px;
    max-width: 40%; /* 50% is a bit much and can overlap w/ other summaries */
    overflow: hidden;
    height: 22px; /* touches tags (mark) on last line w/ bottom:-8px */
    position: absolute;
    left: 0;
    right: 0;
    /* 3px left padding aligns best with code block left border on iOS Safari */
    padding: 0 3px;
    bottom: -8px; /* same as .super-container gap (2x vertical padding) w/o time strings */
    line-height: 160%; /* for vertical positioning of dots */
    margin-left: auto;
    margin-right: auto;
    width: fit-content;
    cursor: pointer;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }

  .item > :global(.log-summary) {
    display: flex;
    justify-content: flex-start;
    max-width: 25%;
    right: auto;
    padding-right: 0;
    margin: 0;
  }
  .item > :global(.dependents-summary) {
    display: flex;
    justify-content: flex-end;
    max-width: 25%;
    left: auto;
    padding-left: 0;
    margin: 0;
  }

  .item > :global(.deps-summary > .deps-dot) {
    color: #666;
  }
  .item > :global(.deps-summary > .deps-dot.async) {
    color: #999;
  }
  .item > :global(.dependents-summary > .dependents-dot) {
    color: #555;
  }
  .item > :global(.dependents-summary > .dependents-dot.visible) {
    color: #999;
  }
  .item > :global(.log-summary > .log-triangle),
  .item > :global(.deps-summary > .deps-triangle),
  .item > :global(.dependents-summary > .dependents-triangle) {
    display: none;
    font-size: 10px;
    color: #999;
    position: relative;
    bottom: 2px; /* triangle can use 2px extra space below */
  }

  .item > :global(.deps-summary > .deps-dot) {
    margin-right: 1px;
  }

  /* increase dot margins on non-iOS due to ~1px less padding of monospace characters */
  @supports not (-webkit-touch-callout: none) {
    .item > :global(.log-summary > .log-dot) {
      margin-right: 2px;
    }
    .item > :global(.deps-summary > .deps-dot) {
      margin: 0 1px;
    }
    .item > :global(.dependents-summary > .dependents-dot) {
      margin-left: 1px;
    }
  }

  .item > :global(.deps-and-dependents) {
    display: none;
    font-size: 80%;
    line-height: 160%;
    /* white-space: nowrap; */
    padding-top: 10px;
    padding-bottom: 7px; /* avoid overlap with summaries */
  }
  /* we apply negative margin only when direct child, e.g. for when a multi-column macro is left open */
  .item > :global(.deps-and-dependents) {
    margin-left: -6px;
  }
  .container:global(.showDeps) .item > :global(.deps-and-dependents),
  .container:global(.showDependents) .item > :global(.deps-and-dependents) {
    display: block;
  }
  .item > :global(.deps-and-dependents > .deps),
  .item > :global(.deps-and-dependents > .dependents) {
    display: none;
  }
  .container:global(.showDeps) .item > :global(.deps-and-dependents > .deps),
  .container:global(.showDeps) .item > :global(.deps-summary > .deps-triangle),
  .container:global(.showDependents) .item > :global(.deps-and-dependents > .dependents),
  .container:global(.showDependents) .item > :global(.dependents-summary > .dependents-triangle) {
    display: inline;
  }

  .container:global(.showDeps) .item > :global(.deps-summary > .deps-dot),
  .container:global(.showDependents) .item > :global(.dependents-summary > .dependents-dot) {
    display: none;
  }

  .item > :global(.deps-and-dependents mark),
  .item > :global(.deps-and-dependents a) {
    opacity: 0.75;
  }
  .item > :global(.deps-and-dependents span.visible mark),
  .item > :global(.deps-and-dependents span.async mark) {
    opacity: 1;
  }
  .item > :global(.deps-and-dependents span.visible a),
  .item > :global(.deps-and-dependents span.async a) {
    opacity: 1;
  }

  .item > :global(.deps-and-dependents .deps-title),
  .item > :global(.deps-and-dependents .dependents-title) {
    color: black;
    background: #bbb;
    font-weight: 700;

    /* border: 1px solid #999; */
    padding: 0 4px;
    border-radius: 4px 0 0 4px;
    white-space: nowrap;
    cursor: pointer;
  }

  .item > :global(.content span.macro-error) {
    color: #f55;
    border: 1px dashed #f55;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px; /* same as code */
    font-weight: 400;
    border-radius: 4px;
    padding: 2px 4px;
  }

  .item > :global(.content .MathJax) {
    margin-top: 0 !important; /* override some highly specific css */
    margin-bottom: 0 !important;
  }
  .item > :global(.content .math-display) {
    padding-top: 4px;
    padding-bottom: 4px;
  }
  .item > :global(.content > .math-display:first-child) {
    padding-top: 0;
  }
  .item > :global(.content > .math-display:last-child) {
    padding-bottom: 0;
  }

  .item > :global(.content blockquote .MathJax) {
    display: block;
  }

  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    .super-container {
      padding-left: 0; /* assume no border issue, maximize space use */
    }
    .item {
      font-size: 15px;
      line-height: 24px;
      min-height: 45px; /* single line height */
    }
    .item > :global(.content a) {
      line-height: 20px;
    }
    /* NOTE: these font sizes should match those in Editor */
    .item > :global(.content :is(pre, code)) {
      font-size: 11px;
      line-height: 20px;
    }
    .item > :global(:is(.log-summary, .deps-summary, .dependents-summary)) {
      bottom: -9px; /* works better with fonts on iPhone */
    }

    /* drop optional labels for buttons with icons/symbols */
    .optional-label {
      display: none;
    }

    /* smaller menu fonts can take a little more weight */
    /* .item > :global(.menu a),
    .item > :global(.menu mark) {
      font-weight: 700;
    } */
  }
  /* adapt to smaller iPhones (e.g. iPhone 12 mini) and Androids (even large ones like Galaxy S21 Ultra) */
  @media only screen and (max-width: 400px) {
    .item {
      font-size: 14px;
      line-height: 23px;
      min-height: 45px; /* single line height */
    }
    .item > :global(.content a) {
      line-height: 19px;
    }
  }
</style>
