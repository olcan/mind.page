<script lang="ts">
  const _ = globalThis['_'] // imported in client.ts
  const marked = globalThis['marked'] // imported (and set up) in client.ts
  import {
    highlight,
    blockRegExp,
    extractBlock,
    replaceTags,
    tagRegexExclusions,
    parseTags,
    renderTag,
    isBalanced,
    numberWithCommas,
    invalidateElemCache,
    adoptCachedElem,
    skipEscaped,
    exclusionRegExp,
    skipExclusions,
    hash as _hash,
  } from '../util.js'

  import { Circle, Circle2 } from 'svelte-loading-spinners'
  import Editor from './Editor.svelte'
  export let editable = true
  export let pushable = false
  export let previewable = false
  export let editing = false
  export let focused = false
  export let saving = false
  export let running = false
  export let admin = false
  export let fixed = false
  export let source = null
  export let path = null
  export let hidden = false
  export let showLogs = false
  export let selectionStart = 0
  export let selectionEnd = 0
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
  export let matchingTerms: any
  export let matchingTermsSecondary: any
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
  $: saveable = text.trim().length > 0 /* otherwise saving would delete, so just cancel */
  export let onEditing = (
    index: number,
    editing: boolean,
    cancelled: boolean = false,
    run: boolean = false,
    e: KeyboardEvent = null
  ) => {}
  export let onFocused = (index: number, focused: boolean) => {}
  export let onEdited = (index: number, text: string) => {}
  export let onEditorKeyDown = (e: KeyboardEvent) => {}
  export let onEscape = e => true // false means handled/ignore
  export let onPastedImage = (url: string, file: File, size_handler = null) => {}
  export let onRun = (index: number = -1, e: MouseEvent = null) => {}
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
  function onMouseDown() {
    mouseDownTime = Date.now()
  }
  function onClick(e) {
    // reject click without mousedown within 250ms (can happen due to tags shifting during click)
    if (Date.now() - mouseDownTime > 250) return
    // ignore clicks on loading div
    if ((e.target as HTMLElement).closest('.loading')) return
    // ignore clicks on inputs or buttons
    if (e.target.closest('input, button')) return
    // console.debug(e.target);
    // ignore clicks on "clickable" elements
    let clickable = e.target.closest('[_clickable]')
    if (clickable && (!clickable['_clickable'] || clickable['_clickable'](e))) return true
    if (
      getSelection().type == 'Range' &&
      (e.target.contains(getSelection().anchorNode) || e.target.contains(getSelection().focusNode))
    )
      return // ignore click when text is selected in target element

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
    onRun(index, e)
  }

  function onIndexClick(e) {
    e.stopPropagation()
    e.preventDefault()
    onTouch(index, e)
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
    matchingTerms: any, // space-separated string converted to Set
    matchingTermsSecondary: any, // space-separated string converted to Set
    depsString: string,
    dependentsString: string,
    version: number
  ) {
    // NOTE: we exclude text (arg 0) from cache key since it should be captured in deephash
    const cache_key = 'html-' + _hash(Array.from(arguments).slice(1).toString())
    window['_html_cache'][id] ??= new Map()
    if (window['_html_cache'][id].has(cache_key)) {
      // console.debug("toHTML skipped");
      return window['_html_cache'][id].get(cache_key)
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
    if (expanded && !expanded.error && expanded.deephash == deephash && expanded.version == version) {
      text = expanded.text // use prior expansion
      cacheIndex = expanded.count
    } else {
      // console.debug('expanding macros while rendering', name)
      expanded = {} // reset macro expansion state
      const replaceMacro = (m, js) => {
        if (!isBalanced(js)) return m // skip unbalanced macros that are probably not macros, e.g. ((x << 2) >> 2)
        try {
          return window['_item'](id).eval(js, {
            trigger: 'macro_' + cacheIndex++,
            cid: `${id}-${deephash}-${cacheIndex}`, // enable replacement of $cid
          })
        } catch (e) {
          expanded.error ??= e // record first error & continue replacing
          // no need to log missing dependency errors
          if (!e.message.startsWith('eval missing dependencies')) console.error(`macro error in item ${name}: ${e}`)
          return `<span class="macro-error" title="${_.escape(e.message)}">${js}</span>`
          // return `<span class="macro-error">MACRO ERROR: ${e.message}</span>`
        }
      }
      text = text.replace(/<<(.*?)>>/g, skipEscaped(replaceMacro))
      // save expansion if no errors
      if (!expanded.error) {
        expanded.text = text
        expanded.deephash = deephash
        expanded.version = version
        expanded.count = cacheIndex
        onMacrosExpanded(index, expanded)
      }
    }

    // pre-process block types to allow colon-separated parts, taking only last part without a period
    text = text.replace(blockRegExp('\\S+?'), (m, pfx, type, body) => {
      if (type.includes(':')) type = _.findLast(type.split(':'), s => !s.includes('.')) ?? ''
      return pfx + '```' + type + '\n' + body + '```'
    })

    // force line break after block endings (most useful for macro-generated blocks that may be followed by text)
    const block_regex = blockRegExp(/\S*?/)
    const regex = new RegExp(block_regex.source + ' *([^\\n]?)', block_regex.flags)
    text = text.replace(regex, (m, pfx, type, body, sfx) => {
      return pfx + '```' + type + '\n' + body + '```' + (sfx ? '\n' + sfx : '')
    })

    // unwrap _markdown(_*) and _md(_*) blocks that are non-empty and NOT removed/hidden
    text = text.replace(blockRegExp('(?:_markdown|_md)(?:_\\S*)? *'), (m, pfx, type, body) => {
      if (type.match(/(?:_removed|_hidden) *$/) || !body) return m
      // remove trailing newline in body (as in extractBlock) to avoid extra lines between blocks
      // for tables/blockquotes, we instead append an escape to force breaking across blocks w/o forcing spacing
      // note the second \n comes from the closing block delimiter ```\n since blockRegExp excludes the final \n
      if (!body.match(/(?:^|\n)\s*[|>][^\n]*\n$/)) body = body.replace(/\n$/, '')
      else body = body.replace(/\n$/, '\n\\')
      body = body.replace(/((?:^|\n) *)\\```/g, '$1```') // unescape nested blocks
      return pfx + body
    })

    const firstTerm = matchingTerms ? matchingTerms.match(/^\S+/)[0] : ''
    matchingTerms = new Set<string>(matchingTerms.split(' ').filter(t => t))
    matchingTermsSecondary = new Set<string>(matchingTermsSecondary.split(' ').filter(t => t))
    missingTags = new Set<string>(missingTags.split(' ').filter(t => t))
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

    let depsTitle = ''
    let dependentsTitle = ''
    if (depsString || dependentsString) {
      text += `\n<div class="deps-and-dependents">`
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

    // remove removed sections, except inside blocks
    const blockExclusions = [
      '(?:^|\\n) *```.*?\\n *```', // multi-line block
      '(?:^|\\n)     *[^-*+ ][^\\n]*(?:$|\\n)', // 4-space indented block
    ]
    text = text.replace(
      exclusionRegExp(blockExclusions, /<\!-- *removed *-->.*?<\!-- *\/removed *--> *?(\n|$)/gs),
      skipExclusions(m => ``)
    )

    // extract _log blocks (processed for summary at bottom)
    const log = extractBlock(text, '_log')

    // introduce a line break between any styling html and first tag
    text = text.replace(/^(<.*>)\s+#/, '$1\n#')

    // parse tags and construct regex for matching
    const tags = parseTags(text).raw
    const regexTags = tags.map(_.escapeRegExp).sort((a, b) => b.length - a.length)
    const tagRegex = `(^|\\s|\\()(${regexTags.join('|')})`
    const isMenu = tags.includes('#_menu')

    // replace naked URLs (regex from util.js) with markdown links (or images) named after host name
    // we use the same exclusions as tags (or replaceTags) to skip code blocks, html tags, etc
    const urlRegex = new RegExp(
      tagRegexExclusions +
        '|' +
        /(^|\s|\()((?:go\/|[a-z](?:[-a-z0-9\+\.])*:\/\/[^\s)<>/]+\/?)[^\s)<>:]*[^\s)<>:;,.])/.source,
      'g'
    )
    const replaceURLs = text =>
      text.replace(urlRegex, (m, pfx, url, offset, orig_str) => {
        if (pfx === undefined) return m // skip exclusion
        // disallow matching prefix ](\s+ to avoid matching urls inside markdown links
        if (orig_str.substring(0, offset + pfx.length).match(/\]\(\s*$/)) return m
        if (url.startsWith('go/')) url = 'http://' + url
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
          const obj = new URL(url)
          let label = obj.host + ((obj.pathname + obj.search + obj.hash).length > 1 ? '/…' : '')
          if (obj.host == 'go') label = obj.host + obj.pathname + (obj.search + obj.hash ? '/…' : '') // always include path for collapse search/hash
          if (url.match(/\.(jpeg|jpg|png|gif|svg)$/i)) {
            return `${pfx}<img title="${_.escape(label)}" src="${url}">${sfx}`
          }
          return `${pfx}[${label}](${url})${sfx}`
        } catch (_) {
          return pfx + url + sfx
        }
      })

    const regexTerms = Array.from(matchingTerms)
      .map(_.escapeRegExp)
      .sort((a, b) => b.length - a.length)
    let mathTermRegex = new RegExp(`\$\`.*(?:${regexTerms.join('|')}).*\`\$`, 'i')

    const parentLabel = label.replace(/\/[^\/]*$/, '')
    const parentLabelText = labelText.replace(/\/[^\/]*$/, '')
    const grandParentLabel = label.replace(/\/[^\/]*?\/[^\/]*$/, '')
    const grandParentLabelText = labelText.replace(/\/[^\/]*?\/[^\/]*$/, '')

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
        if (str.match(/^ *$/)) str += '<br>\n'

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
            // make relative tags absolute
            if (label && tag != label && tag.startsWith('#///')) tag = grandParentLabelText + tag.substring(3)
            else if (label && tag != label && tag.startsWith('#//')) tag = parentLabelText + tag.substring(2)
            else if (label && tag != label && tag.startsWith('#/')) tag = labelText + tag.substring(1)

            const lctag = tag.toLowerCase()
            let classNames = ''
            if (missingTags.has(lctag)) classNames += ' missing'
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
            // always include short (2-digits or less) numeric label suffixes (e.g. .../99/9/9) to help disambiguate
            if (lctag == label && contextLabel && (matchingTerms.has(lctag) || matchingTermsSecondary.has(lctag)))
              reltag = '#…' + tag.substring(contextLabel.replace(/(?:\/\d\d?)+$/, '').length)

            // shorten prefix-matching labels, including short numeric suffix (see comment above)
            if (
              lctag == label &&
              label.includes('/') &&
              label.length > firstTerm.length &&
              label[firstTerm.length] == '/' &&
              label.substring(0, firstTerm.length) == firstTerm
            )
              reltag = '#…' + tag.substring(firstTerm.replace(/(?:\/\d\d?)+$/, '').length)
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
    //.replace(/<hr(.*?)>\s*<br>/g, '<hr$1>')

    // remove *_removed blocks
    text = text.replace(blockRegExp(/\S*_removed/), '')

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
    let renderer = new marked.Renderer()
    renderer.link = (href, title, text) => {
      if (href.startsWith('##')) {
        // fragment link
        const fragment = href.substring(1)
        return `<a href="${_.escape(fragment)}" title="${_.escape(href)}" onclick="_handleLinkClick('${id}','${_.escape(
          href
        )}',event)">${text}</a>`
      } else if (href.startsWith('#')) {
        // tag link
        let tag = href
        // make relative tag absolute
        if (label && tag.startsWith('#///')) tag = grandParentLabelText + tag.substring(3)
        else if (label && tag.startsWith('#//')) tag = parentLabelText + tag.substring(2)
        else if (label && tag.startsWith('#/')) tag = labelText + tag.substring(1)
        const lctag = tag.toLowerCase()
        let classNames = 'link'
        if (missingTags.has(lctag)) classNames += ' missing'
        classNames = classNames.trim()
        return `<mark class="${classNames}" title="${_.escape(tag)}" onmousedown="_handleTagClick('${id}','${_.escape(
          tag
        )}','${_.escape(text)}',event)" onclick="event.preventDefault();event.stopPropagation();">${text}</mark>`
      }
      // For javascript links we do not use target="_blank" because it is unnecessary, and also because in Chrome it causes the javascript to be executed on the new tab and can trigger extra history or popup blocking there.
      // NOTE: rel="opener" is required by Chrome for target="_blank" to work. rel="external" is said to replace target=_blank but does NOT open a new window (in Safari or chrome), so we are forced to used _blank+opener.
      let attribs = ''
      if (!href.startsWith('javascript:')) attribs = ` target="_blank" rel="opener"`
      return `<a${attribs} title="${_.escape(href)}" href="${_.escape(
        href
      )}" onclick="_handleLinkClick('${id}','${_.escape(href)}',event)">${text}</a>`
    }
    // marked.use({ renderer });
    marked.setOptions({
      renderer: renderer,
      highlight: (code, language) => {
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
      langPrefix: '',
    })

    // assign indices to checkboxes to be moved into _checkbox_index attribute below
    // adding text after checkbox also allows checkbox items that start w/ tag (<mark>) or other html
    let checkboxIndex = 0
    text = text.replace(/(?:^|\n)\s*(?:\d+\.|[-*+]) \[[xX ]\] /g, m => m + '%%' + checkboxIndex++ + '%%')

    // parse markdown, adding <br> on a each single line break, see https://marked.js.org/using_advanced#options
    text = marked.parse(text, { breaks: true })

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
    // note this wrapper div excludes deps-and-dependents, deps-summary, and menu-<id> divs (created in afterUpdate)
    // also perform _static_ (vs dynamic in afterUpdate) removal of tail whitespace
    text =
      `<div class="content${isMenu ? ' menu' : ''}">` +
      text.replace(/^(.*?)($|<div class="deps-and-dependents">)/s, (m, content, sfx) => {
        const keep = []
        let length = 0
        do {
          length = content.length
          content = content
            .replace(/(?:\s|<br>)*$/, '')
            .replace(
              /(?:<br>|&nbsp;|\s|<mark class="hidden"(?:"[^"]*"|[^>"])*>\S*?<\/mark>)*((?:<\/p>)?)$/,
              (m, sfx) => {
                keep.push(...(m.match(/<mark class="hidden"(?:"[^"]*"|[^>"])*>\S*?<\/mark>/g) ?? []))
                return sfx
              }
            )
            .replace(/<p>(?:<\/p>)?$/, '') // drop empty <p> tag, allowing unclosed <p> as well
            // note <> should be escaped in code blocks, so we can use that to avoid matching across blocks
            .replace(/<pre><code class="_log">([^<>]*?)<\/code><\/pre>$/s, m => (keep.push(m), ''))
        } while (content.length < length) // keep trying until content length is unchanged
        if (keep.length) content += '\n' + keep.join(' ') + '\n'
        return content + '</div>' + sfx
      })

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
      return m.substring(0, m.length - 1) + ` onclick="_handleLinkClick('${id}','${_.escape(href)}',event)">`
    })

    // append log summary div
    if (log) {
      const lines = log.split('\n')
      let summary = '<span class="log-triangle">▼</span>'
      lines.forEach(line => {
        const type = line.match(/^ERROR:/)
          ? 'error'
          : line.match(/^WARNING:/)
            ? 'warn'
            : line.match(/^INFO:/)
              ? 'info'
              : line.match(/^DEBUG:/)
                ? 'debug'
                : 'log'
        summary += `<span class="log-dot console-${type}">⸱</span>`
      })
      text += `\n<div class="log-summary" onclick="_handleLogSummaryClick('${id}',event)" title="${lines.length} log lines">${summary}</div>`
    }

    // append dependencies ("deps") summary
    if (depsString) {
      const summary =
        '<span class="deps-triangle">▼</span>' +
        depsString
          .split(' ')
          .map(dep => `<span class="deps-dot${dep.endsWith('(async)') ? ' async' : ''}">⸱</span>`)
          .join('')
      text += `\n<div class="deps-summary" onclick="_handleDepsSummaryClick('${id}',event)" title="${depsTitle}">${summary}</div>`
    }
    // append dependents ("deps") summary
    if (dependentsString) {
      const summary =
        '<span class="dependents-triangle">▼</span>' +
        dependentsString
          .split(' ')
          .map(dep => `<span class="dependents-dot${dep.endsWith('(visible)') ? ' visible' : ''}">⸱</span>`)
          .join('')
      text += `\n<div class="dependents-summary" onclick="_handleDependentsSummaryClick('${id}',event)" title="${dependentsTitle}">${summary}</div>`
    }

    // include html cache key in content to include in svelte content cache key and force svelte update whenever html is re-generated even if generated html is identical since arguments (in particular deephash and version) may capture changes not reflected in generated html
    text += `<!-- html_cache_key=${cache_key} -->`

    // do not cache with macro errors
    if (expanded.error) return text
    window['_html_cache'][id].set(cache_key, text)
    limit_cache_size(window['_html_cache'][id], _html_cache_limit_per_item)
    return text
  }

  // we use afterUpdate hook to make changes to the DOM after rendering/updates
  import { afterUpdate, onDestroy } from 'svelte'
  let container: HTMLDivElement
  let itemdiv: HTMLDivElement

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
          // destroy all children and SELF w/ _destroy attribute (and property)
          elem.querySelectorAll('[_destroy]').forEach(e => e['_destroy']())
          elem._destroy?.()
          elem.remove()
        })
      }
    })
  }

  function renderMath(elems, done = null) {
    if (elems.length == 0) return
    window['MathJax']
      .typesetPromise(elems)
      .then(() => {
        const itemdiv = elems[0].closest('.item')
        if (!itemdiv) return
        // NOTE: inTabOrder: false option updates context menu but fails to set tabindex to -1 so we do it here
        itemdiv.querySelectorAll('.MathJax').forEach(elem => elem.setAttribute('tabindex', '-1'))
        if (done) done()
        onResized(id, container, 'math rendered')
      })
      .catch(console.error)
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

  afterUpdate(() => {
    // always report container height for potential changes
    // WARNING: afterUpdate can be triggered for _multiple_ items on every key press in the editor of a single item, so it is critical for onResized to be efficient. These updates were traced to binding such as editor.focused when focusing on an editor or editor.selectionStart when typing into an editor, and then seem to always get propagated to every item that is rendered on the page
    // console.trace()
    // console.debug('afterUpdate', name)
    setTimeout(() => onResized(id, container, 'afterUpdate'), 0)

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

    // insert right-floating div same size as .item-menu, which will also serve as first element of itemdiv
    // NOTE: this is a workaround for a null-parent exception if .item-menu is placed inside .item by Svelte
    if (itemdiv.firstElementChild?.id != 'menu-' + id) {
      let menu = itemdiv.parentElement.querySelector('.item-menu')
      let div = document.createElement('div')
      div.style.width = menu.clientWidth + 'px'
      div.style.height = menu.clientHeight + 'px'
      /* -10px to remove .item padding, +1px for inset (when .bordered), +1px extra clearing space */
      div.style.marginTop = div.style.marginRight = '-8px'
      div.style.float = 'right'
      // div.style.background = "red";
      div.id = 'menu-' + id
      itemdiv.insertBefore(div, itemdiv.firstElementChild)
    }

    // we highlight both primary and secondary matching terms
    const highlightTerms = matchingTerms + ' ' + matchingTermsSecondary
    if (
      hash == itemdiv.firstElementChild.getAttribute('_hash') &&
      highlightTerms == itemdiv.firstElementChild.getAttribute('_highlightTerms')
    ) {
      // console.debug("afterUpdate skipped");
      return
    }
    itemdiv.firstElementChild.setAttribute('_hash', hash)
    itemdiv.firstElementChild.setAttribute('_highlightTerms', highlightTerms)
    // console.debug("afterUpdate", name);

    // cache/restore any cached elements with _cache_key (invoked again later for elements with scripts)
    cacheElems()

    // highlight matching tags using selected/secondary-selected classes
    const matchingTermSet = new Set<string>(matchingTerms.split(' ').filter(t => t))
    const matchingTermSecondarySet = new Set<string>(matchingTermsSecondary.split(' ').filter(t => t))
    itemdiv.querySelectorAll('mark').forEach(mark => {
      const selected = matchingTermSet.has(mark.title.toLowerCase())
      const secondary_selected = !selected && matchingTermSecondarySet.has(mark.title.toLowerCase())
      mark.classList.toggle('selected', selected)
      mark.classList.toggle('secondary-selected', secondary_selected)
    })

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

      let terms = highlightTerms.split(' ').filter(t => t)
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
    warning = !!itemdiv.querySelector('.console-warn,.warning')

    // trigger typesetting of any math elements
    // NOTE: we do this async to see if we can load MathJax async in template.html
    setTimeout(() => {
      if (!itemdiv) return
      let math = []
      itemdiv.querySelectorAll('span.math,span.math-display').forEach(elem => {
        if (elem.hasAttribute('_rendered')) return
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
          elem.setAttribute('_rendered', Date.now().toString())
        })
      })
    })

    // linkify urls & tags in code comments (regexes from util.js, labeling logic from replaceURLs in toHTML)
    const link_urls = text =>
      text.replace(
        /(^|\s|\()((?:go\/|[a-z](?:[-a-z0-9\+\.])*:\/\/[^\s)<>/]+\/?)[^\s)<>:]*[^\s)<>:;,.])/g,
        (m, pfx, href) => {
          const obj = new URL(href)
          let label = obj.host + ((obj.pathname + obj.search + obj.hash).length > 1 ? '/…' : '')
          if (obj.host == 'go') label = obj.host + obj.pathname + (obj.search + obj.hash) ? '/…' : '' // always include path for collapse search/hash
          return (
            `${pfx}<a href="${_.escape(href)}" target="_blank" title="${_.escape(href)}" ` +
            `onclick="_handleLinkClick('${id}','${_.escape(href)}',event)">${label}</a>`
          )
        }
      )
    const link_tags = text =>
      text.replace(/(^|\s|\()(#[^#\s<>&,.;:!"'`(){}\[\]]+)/g, (m, pfx, tag) => {
        const tag_resolved = window['_resolve_tag'](label, tag) ?? tag
        return `${pfx}<a href="#" title="${_.escape(tag_resolved)}" onmousedown="_handleTagClick('${id}','${_.escape(
          tag_resolved
        )}','${_.escape(tag_resolved)}',event)" onclick="event.preventDefault();event.stopPropagation();">${tag}</a>`
      })
    itemdiv.querySelectorAll('.hljs-comment').forEach(comments => {
      comments.innerHTML = link_tags(link_urls(comments.innerHTML))
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
        let text = item.read()
        let checkboxIndex = 0
        text = text.replace(/(?:^|\n)\s*(?:\d+\.|[-*+]) \[[xX ]\] /g, m => {
          if (checkboxIndex++ == index) return m.replace(/\[[xX ]\]/, elem.hasAttribute('checked') ? '[ ]' : '[x]')
          else return m
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
            let text = item.read()
            text = text.replace(/<input\s(?:"[^"]*"|[^>"])*?type\s*=\s*["']?file(?:"[^"]*"|[^>"])*>|<input>/gi, images)
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
      // a version increment does not make sense since these scripts are considered part of the current version
      // also version increment can cause a render-error loop since elements are not cached on errors
      invalidateElemCache(id)
      // version++; // ensure re-render even if deephash and html are unchanged

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
    // move cached elements into dom to prevent offloading by browser
    window['_elem_cache'][id]?.forEach(adoptCachedElem)
  })

  window['_render_images'] ??= item => renderImages(item.id, item.elem?.querySelectorAll('.item > .content img') ?? [])
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
    renderMath(math, function () {
      dot.querySelectorAll('.node > text > .MathJax > svg > *').forEach(elem => {
        if (!item.elem?.contains(elem)) {
          // console.error("detached _graph elem in item", item.name)
          invalidateElemCache(id)
          return
        }
        let math = elem as SVGGraphicsElement
        let dot = elem.parentNode.parentNode.parentNode.parentNode
        // NOTE: node can have multiple shapes as children, e.g. doublecircle nodes have two
        let shape = dot.children[1] as SVGGraphicsElement // shape (e.g. ellipse) is second child
        let text = dot.children[dot.children.length - 1] // text is last child
        let shaperect = shape.getBBox()
        let textrect = text['_bbox'] // recover text bbox pre-mathjax
        let textscale = textrect.height / shaperect.height // fontsize-based scaling factor
        elem.parentElement.parentElement.parentElement.remove() // remove text node
        dot.appendChild(elem)
        let mathrect = math.getBBox()
        let scale = (0.6 * textscale * shaperect.height) / mathrect.height
        let xt0 = -mathrect.x
        let yt0 = -mathrect.y
        let xt = shaperect.x + shaperect.width / 2 - (mathrect.width * scale) / 2
        let yt = shaperect.y + shaperect.height / 2 + (mathrect.height * scale) / 2
        elem.setAttribute('transform', `translate(${xt},${yt}) scale(${scale},-${scale}) translate(${xt0},${yt0})`)
      })
    })
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
    on:mousedown={onMouseDown}
    on:click={onClick}
    class="container"
    class:editing
    class:focused
    class:saving
    class:error
    class:warning
    class:target
    class:target_context
    class:running
    class:admin
    class:showLogs
    class:bordered={error || warning || running || target || pushable || previewable}
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
      </div>

      <Editor
        id_suffix={id}
        bind:this={editor}
        bind:text
        bind:editorText
        bind:focused
        bind:selectionStart
        bind:selectionEnd
        cancelOnDelete={fixed}
        {onRun}
        {onSave}
        {onPrev}
        {onNext}
        onFocused={focused => onFocused(index, focused)}
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
        <div class="button index" class:leader class:matching on:click={onIndexClick}>{index + 1}</div>
      </div>
      <!-- NOTE: id for .item can be used to style specific items using #$id selector -->
      <div id={'item-' + id} class="item {styleDepsString}" bind:this={itemdiv} class:saving class:headerMinimal>
        <!-- NOTE: arguments to toHTML (e.g. deephash) determine dependencies for (re)rendering -->
        {@html toHTML(
          text || placeholder,
          id,
          deephash,
          labelUnique,
          contextLabel,
          missingTags,
          matchingTerms,
          matchingTermsSecondary,
          depsString,
          dependentsString,
          version
        )}
      </div>
    {/if}
    <div class="loading">
      {#if running}
        <Circle2 size="40" unit="px" />
      {:else if saving}
        <Circle size="25" unit="px" />
      {/if}
      <div class="status" />
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

  .item-menu > .index.leader {
    color: #eee;
  }

  .item-menu > .index.matching {
    color: #9f9;
  }

  .item-menu > .run {
    border-bottom-right-radius: 5px;
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
  .running {
    /* border-color: #246; */
    border-color: #4af; /* dimmed by .loading */
  }
  .pushable {
    border-color: #a52;
  }
  .previewable {
    border-color: #c7c;
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
  .loading > :global(div:not(.status)) {
    opacity: 0.75;
    min-height: var(--size); /* prevent distortion when indicator + status exceed item height */
  }
  .running .loading,
  .saving .loading {
    visibility: visible;
  }
  /* remove .status div when empty */
  .loading .status:empty {
    display: none;
  }
  .loading .status {
    padding: 5px 10px;
    margin-top: 5px;
    font-size: 14px;
    line-height: 24px;
    font-family: 'JetBrains Mono', monospace;
    background: #124; /* progress gradient uses #136 and #013 */
    border-radius: 5px;
    max-width: 90%; /* avoid touching edges of item */
    text-align: center; /* for multi-line status */
    pointer-events: all;
  }
  /* style progress bars for consistency across platforms */
  /* see https://stackoverflow.com/a/32186894 */
  /* background */
  .container .loading :global(progress) {
    background-color: #171717;
    border-radius: 4px;
    width: 100px;
    height: 10px;
  }
  .container .loading :global(progress::-webkit-progress-bar) {
    background-color: #171717;
    border-radius: 4px;
  }
  /* value/foreground */
  .container .loading :global(progress::-webkit-progress-value) {
    background-color: #4af;
    border-radius: 4px;
  }
  .container .loading :global(progress::-moz-progress-bar) {
    background-color: #4af;
    border-radius: 4px;
  }
  .container .loading :global(progress) {
    color: #4af;
    border-radius: 4px;
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
    color: white;
    /* border-color: #4af; */
    /* background: #4af; */
  }
  .item > :global(.content input[type='checkbox']:checked:after) {
    content: '✔︎'; /* could be: ✔︎✓ */
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
  }
  .item > :global(.content a code) {
    background: none;
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
  }
  .item > :global(:is(.content, .deps-and-dependents) mark) {
    color: black;
    background: #999;
    font-weight: 600;
    padding: 0 4px;
    margin: 0;
    border-radius: 4px;
    cursor: pointer;
  }

  /* .menu styling: paragraphs become flex boxes */
  .item > :global(.menu p) {
    display: flex;
    line-height: 24px; /* same as .menu img below */
    width: 96%; /* align right side while leaving space for item number and tapping for editing */
  }
  .item > :global(.menu a),
  .item > :global(.menu mark:not(.hidden)) {
    padding: 4px;
    font-size: 110%;
    font-weight: 600;
  }
  .item > :global(.menu p a),
  .item > :global(.menu p mark:not(.hidden)) {
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
  .item > :global(:is(.content, .deps-and-dependents) mark.label.unique) {
    font-weight: 700;
  }
  .item > :global(:is(.content, .deps-and-dependents) mark.missing) {
    background: #f88;
  }
  .item > :global(:is(.content, .deps-and-dependents) mark.selected) {
    background: #9f9;
  }
  .item > :global(:is(.content, .deps-and-dependents) mark.secondary-selected) {
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

  .item > :global(:is(.content, .deps-and-dependents) mark span.highlight) {
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
    vertical-align: middle;
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
