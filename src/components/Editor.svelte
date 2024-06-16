<script lang="ts">
  export let id_suffix = 'editor'
  export let text = ''
  export let focused = false
  export let editable = true
  export let showButtons = false
  export let cancelOnDelete = false
  export let createOnAnyModifiers = false
  export let clearOnShiftBackspace = false
  export let allowCommandCtrlBracket = false
  export let propagateArrowUpDownAtEdges = false
  // we standardize initial position as 0; can be value.length (e.g. on android)
  // 0 works better for longer items since top of item provides much better context
  export let selectionStart = 0
  export let selectionEnd = 0
  export let onFocused = (focused: boolean) => {}
  export let onEditorKeyDown = (e: KeyboardEvent) => {}
  export let onEdited = text => {}
  export let onEscape = e => true // false means handled/ignore
  export let onPastedImage = (url: string, file: File, size_handler = null) => {}
  export let onDone = (text: string, e: any, cancelled: boolean = false, run: boolean = false) => {}
  export let onRun = () => {}
  export let onSave = () => {}
  export let onPrev = () => {}
  export let onNext = () => {}

  const _ = globalThis['_'] // imported in client.ts

  // import he from "he";
  import {
    highlight,
    replaceTags,
    parseTags,
    numberWithCommas,
    skipEscaped,
    blockRegExp,
    exclusionRegExp,
    skipExclusions,
  } from '../util.js'

  const placeholder = ' '
  let spellcheck = false
  // enable spellcheck iff item contains no blocks (```), macros(<<>>),or #_nospell OR contains #_spell
  $: spellcheck =
    (!text.match(/(?:^|\n)\s*```\S*(?:$|\n)/) /* no blocks */ &&
      !text.match(/(?:^|[^\\])<<.*?>>/) /* no macros */ &&
      !text.match(/(?:^|\s|\()#_nospell\b/)) ||
    !!text.match(/(?:^|\s|\()#_spell\b/)

  let editor: HTMLDivElement
  let backdrop: HTMLDivElement
  let highlights: HTMLDivElement
  let textarea: HTMLTextAreaElement

  // set of languages w/ particular comment begin syntax
  const languages_by_comment_begin = begins => {
    begins = [begins].flat().map(String)
    return new Set(
      window['hljs']
        .listLanguages()
        .map(
          lang => (
            (lang = window['hljs'].getLanguage(lang)),
            lang.contains.find(
              c =>
                (c.scope == 'comment' && begins.includes(String(c.begin))) ||
                // note variants may or may not have been flattened out based on language highlighting on page
                c.variants?.find(c => c.scope == 'comment' && begins.includes(String(c.begin)))
            )
              ? [...lang.name.split(/[\s,]+/), ...(lang.aliases ?? [])]
              : []
          )
        )
        .flat()
        .map(s => s.toLowerCase())
    )
  }

  // languages that support // comments (e.g. javascript)
  const double_slash_comment_languages = languages_by_comment_begin('//')
  // languages that support # comments (e.g. python)
  const hash_comment_languages = languages_by_comment_begin('#')
  // aliases for markdown, to be treated as (embedded) html for comment syntax
  const markdown_aliases = new Set(['markdown', ...window['hljs'].getLanguage('markdown').aliases])
  // languages that support html-like <!-- comments -->
  const html_comment_languages = new Set([...languages_by_comment_begin('/\x3C!--/'), ...markdown_aliases])
  // languages that support mathematica-like (* comments *)
  const mathematica_comment_languages = languages_by_comment_begin(/\(\*/)
  // languages that support c-like /* comments */
  const c_comment_languages = languages_by_comment_begin('/\\*')
  // languages that support % comments (e.g. tex)
  const percent_comment_languages = languages_by_comment_begin('%')
  // languages that support -- comments (e.g. sql)
  const double_dash_comment_languages = languages_by_comment_begin(['--', /--/])

  // NOTE: Highlighting functions are only applied outside of blocks, and only in the order defined here. Ordering matters and conflicts (esp. of misinterpreted delimiters) must be avoided carefully. Tags are matched using a specialized regex that only matches a pre-determined set returned by parseTags that excludes blocks, tags, math, etc. Also we generally can not highlight across lines due to line-by-line parsing of markdown.
  function highlightTags(text, tags) {
    if (tags.length == 0) return text
    const regexTags = tags.map(_.escapeRegExp).sort((a, b) => b.length - a.length)
    const tagRegex = `(^|\\s|\\()(${regexTags.join('|')})`
    // NOTE: this replacement IGNORES the careful exclusions performed by parseTags (see util.js) other than blocks (e.g. will highlight tags inside html tags that also occur outside of html tags). We fix this below by undoing the replacement in highlightOther.
    return replaceTags(text, tagRegex, (m, pfx, tag) => pfx + `<mark>${tag}</mark>`, true /* use escaped exclusions */)
  }
  function highlightOther(text) {
    // NOTE: lack of negative lookbehind means we have to match the previous character, which means we require at least one character between an ending delimiter and the start of a new delimiter, e.g. <br><br> or <center></center> would not highlight the second tag; as a workaround, we do not match "><", so adjacent tags are highlighted together
    // NOTE: to prevent any nested highlights, we use a single regex w/ alternatives where each alternative contains exactly one capture group (content) that can be used to detect which alternative matched
    // NOTE: we match comments and macros separately later as they can be used as section delimiters
    // NOTE: this can match either a single html tag, e.g. <p> or a full range of open/close tags and this turns out to be fine since the whole range can highlighted as html either way
    const macro = /&lt;&lt;(.*?)&gt;&gt;/g
    const comment = /&lt;!--(.*?)--&gt;(?:(?!&gt;)|$)/g
    const html = /&lt;((?=[/\w]).*?(?:[/\w]|&#39;|&quot;))&gt;(?:(?!&gt;)|$)/g
    const math1 = /\$\$`(.*?)`\$\$/g
    const math2 = /\$`(.*?)`\$/g
    const code1 = /``(.*?)``/g
    const code2 = /`(.*?)`/g
    const combine = (...regexes) => regexes.map(r => r.source).join('|')
    return text.replace(
      new RegExp(combine(macro, comment, html, math1, math2, code1, code2), 'g'),
      skipEscaped((m, macro, comment, html, math1, math2, code1, code2) => {
        m = m.replace(/<mark>(.*?)<\/mark>/g, '$1') // undo any tag highlights
        // note we leave section-delimiting comments/macros untouched for highlightMacrosAndComments
        // see below for section-delimiter patterns
        // if (macro != undefined || comment != undefined) return m
        if (macro != undefined)
          if (/^ *_?(?:assistant|model|agent|system|user)(?: *\([^\n]*\))? *$/.test(macro)) return m
          else
            return (
              '<span class="macro"><span class="macro-delimiter">&lt;&lt;</span>' +
              highlight(_.unescape(macro), 'js') +
              '<span class="macro-delimiter">&gt;&gt;</span></span>'
            )
        if (comment != undefined)
          if (/^ *\/?(?:removed|hidden) *$/.test(comment)) return m
          else return highlight(_.unescape(m), 'html')
        if (html != undefined) return highlight(_.unescape(m), 'html')
        if (math1 != undefined || math2 != undefined)
          return `<span class="math">` + highlight(_.unescape(m), 'latex') + `</span>`
        if (code1 != undefined) return `<span class="code">\`\`${code1}\`\`</span>`
        if (code2 != undefined) return `<span class="code">\`${code2}\`</span>`
      })
    )
  }
  function highlightSectionDelimiters(text) {
    const comment = /&lt;!--( *\/?(?:removed|hidden) *)--&gt;(?:(?!&gt;)|$)/g
    const macro = /&lt;&lt;( *_?(?:assistant|model|agent|system|user)(?: *\([^\n]*\))? *)&gt;&gt;/g
    const combine = (...regexes) => regexes.map(r => r.source).join('|')
    return text.replace(
      new RegExp(combine(macro, comment), 'g'),
      skipEscaped((m, macro, comment) => {
        m = m.replace(/<mark>(.*?)<\/mark>/g, '$1') // undo any tag highlights
        // note we highlight as regular macro or comment for now
        if (macro != undefined)
          return (
            '<span class="macro"><span class="macro-delimiter">&lt;&lt;</span>' +
            highlight(_.unescape(macro), 'js') +
            '<span class="macro-delimiter">&gt;&gt;</span></span>'
          )
        if (comment != undefined) return highlight(_.unescape(m), 'html')
      })
    )
  }
  function highlightTitles(text) {
    return text.replace(/^(\s{0,3}#{1,6}\s+)(.+)$/, (_, pfx, title) => pfx + `<span class="title">${title}</span>`)
  }

  function highlightLinks(text) {
    return text
      .replace(/\[(?:[^\]]|\\\])*[^\\]\]\((?:[^\)]|\\\))*[^\\)]\)/g, link => `<span class="link">${link}</span>`)
      .replace(
        // same as in link_urls above, see comments there
        /(^|\s|\()((?:go\/|[a-z](?:[-a-z0-9\+\.])*:\/\/[^\s)<>/]+\/?)[^\s)<>:]*[^\s)<>:,.])/gi,
        (m, pfx, href) => pfx + `<span class="link">${href}</span>`
      )
  }

  function getMatchingDelimiter(char) {
    switch (char) {
      case '(':
        return ')'
      case ')':
        return '('
      case '[':
        return ']'
      case ']':
        return '['
      case '{':
        return '}'
      case '}':
        return '{'
      default:
        throw new Error(`unknown delimiter: ${char}`)
    }
  }

  function findMatchingOpenDelimiter(text, pos) {
    let close = text[pos]
    let open = getMatchingDelimiter(close)
    let closed = 1
    while (closed > 0 && pos >= 0) {
      pos--
      if (text[pos] == open) closed--
      else if (text[pos] == close) closed++
    }
    return pos
  }

  function findMatchingCloseDelimiter(text, pos) {
    let open = text[pos]
    let close = getMatchingDelimiter(open)
    let opened = 1
    while (opened > 0 && pos < text.length) {
      pos++
      if (text[pos] == close) opened--
      else if (text[pos] == open) opened++
    }
    return pos
  }

  function updateTextDivs() {
    let text = textarea.value || placeholder
    let insideBlock = false
    let language = ''
    let code = ''
    let html = ''
    const tags = parseTags(_.unescape(text)).raw
    text.split('\n').map(line => {
      // note marked seems to allow anything after block delimiter, so we do the same
      if (!insideBlock && line.match(/^\s*```/)) {
        insideBlock = true
        language = line.match(/^\s*```(\S*)(?:_removed|_hidden|_tmp)?/).pop()
        // if language spec contains colon separators, take last part without a period
        if (language.includes(':')) language = _.findLast(language.split(':'), s => !s.includes('.')) ?? ''
        code = ''
        html += line + '\n' // leave block delimiter as is
      } else if (insideBlock && line.match(/^\s*```/)) {
        html += '<div class="block">'
        // drop any underscore (_+) prefix (treated as editor-only highlighting)
        language = language.replace(/^_+/, '')
        html += highlight(code, language)
        html += '</div>\n'
        insideBlock = false
        html += line + '\n' // leave block delimiter as is
      } else if (insideBlock) {
        code += line + '\n'
      } else {
        if (line.match(/^     *[^-*+ ]/)) html += _.escape(line) + '\n'
        else html += highlightLinks(highlightTitles(highlightOther(highlightTags(_.escape(line), tags)))) + '\n'
      }
    })
    // append unclosed block as regular markdown
    if (insideBlock) html += highlightLinks(highlightTitles(highlightOther(highlightTags(_.escape(code), tags))))

    // apply special sections and delimiter highlights (delayed from highlightOther)
    // we have to apply exclusions for blocks to prevent messing with blocks (just like the loop above)
    const exclusions = [
      '(?:^|\\n) *```.*?\\n *```', // multi-line block
      '(?:^|\\n)     *[^-*+ ][^\\n]*(?:$|\\n)', // 4-space indented block
    ]
    html = html.replace(
      exclusionRegExp(exclusions, /(^|\n)( *&lt;!-- *hidden *--&gt;.+?&lt;!-- *\/hidden *--&gt; *\n)/gs),
      skipExclusions((m, pfx, body) => `${pfx}<div class="section hidden">${highlightSectionDelimiters(body)}</div>`)
    )
    html = html.replace(
      exclusionRegExp(exclusions, /(^|\n)( *&lt;!-- *removed *--&gt;.+?&lt;!-- *\/removed *--&gt; *\n)/gs),
      skipExclusions((m, pfx, body) => `${pfx}<div class="section removed">${highlightSectionDelimiters(body)}</div>`)
    )
    // highlight "agent" sections
    html = html.replace(
      exclusionRegExp(
        exclusions,
        /(^|\n)( *&lt;&lt; *_?(?:assistant|model|agent)(?: *\([^\n]*\))? *&gt;&gt;.+?\n?)( *&lt;&lt; *(?:system|user)(?: *\([^\n]*\))? *&gt;&gt;|$)/gs
      ),
      skipExclusions(
        (m, pfx, body, sfx) =>
          `${pfx}<div class="section agent">${highlightSectionDelimiters(body)}</div>${highlightSectionDelimiters(sfx)}`
      )
    )
    // highlight delimiter macros not used as "agent" section delimiters
    html = html.replace(
      exclusionRegExp(exclusions, /(^|\n)( *&lt;&lt; *_?(?:system|user)(?: *\([^\n]*\))? *&gt;&gt;)/gs),
      skipExclusions((m, pfx, body) => `${pfx}${highlightSectionDelimiters(body)}`)
    )

    // highlight block delimiters
    html = html.replace(
      /(^|\n)( *```[^\n]*\n)(.*?)\n?( *```)/gs, // note the \n before the closing delimiter was added after block div
      (m, pfx, open, block, close) =>
        `${pfx}<span class="block-delimiter">${open}</span>${block}<span class="block-delimiter">${close}</span>`
    )
    highlights.innerHTML = html

    // linkify urls & tags in comments (regexes from util.js)
    // we allow semi-colon in tail of url to avoid breaking html entities (which are ok for display in editor)
    // note for simplicity we do not yet have a separate url regex for escaped html
    const link_urls = text =>
      text.replace(
        /(^|\s|\()((?:go\/|[a-z](?:[-a-z0-9\+\.])*:\/\/[^\s)<>/]+\/?)[^\s)<>:]*[^\s)<>:,.])/gi,
        (m, pfx, url) => `${pfx}<a>${url}</a>`
      )
    const link_tags = text => text.replace(/(^|\s|\()(#[^#\s<>&,.;:!"'`(){}\[\]]+)/g, '$1<a>$2</a>')
    highlights.querySelectorAll('.hljs-comment').forEach(comments => {
      comments.innerHTML = link_tags(link_urls(comments.innerHTML))
    })

    // determine matched/unmatched delimiter highlights based on caret position
    // we handle the most common delimiters used for extended blocks of code that would not be highlighted otherwise
    // we intentionally exclude <> (used for tags, comparisons, etc) and string quotes (already highlighted)
    // also watch out for ligatures (e.g. << or >> or [||]) that will change color _together_
    const matched_positions = []
    const unmatched_positions = []
    const clean_text = cleanTextForDelimiterMatching(text)
    if (textarea.selectionStart == textarea.selectionEnd && ')]}'.includes(clean_text[textarea.selectionStart])) {
      let matchpos = findMatchingOpenDelimiter(clean_text, textarea.selectionStart)
      if (matchpos >= 0) matched_positions.push(matchpos, textarea.selectionStart)
      else unmatched_positions.push(textarea.selectionStart)
    } else if (
      textarea.selectionStart == textarea.selectionEnd &&
      '([{'.includes(clean_text[textarea.selectionStart - 1])
    ) {
      let matchpos = findMatchingCloseDelimiter(clean_text, textarea.selectionStart - 1)
      if (matchpos < text.length) matched_positions.push(textarea.selectionStart - 1, matchpos)
      else unmatched_positions.push(textarea.selectionStart - 1)
    }

    highlightPositions(matched_positions, 'matched')
    highlightPositions(unmatched_positions, 'unmatched')

    textarea.style.height = backdrop.scrollHeight + 'px'
  }

  function cleanTextForDelimiterMatching(text) {
    // replace all escaped characters w/ spaces
    text = text.replace(/\\./g, m => ' '.repeat(m.length))
    // replace hljs-string and hljs-regexp spans w/ spaces
    const walker = document.createTreeWalker(highlights, NodeFilter.SHOW_TEXT)
    let node
    let offset = 0
    while ((node = walker.nextNode())) {
      if (['hljs-string', 'hljs-regexp'].includes(node.parentElement.className))
        text = text.slice(0, offset) + ' '.repeat(node.length) + text.slice(offset + node.length)
      offset += node.length
    }
    return text
  }

  function highlightPositions(pos, type) {
    const walker = document.createTreeWalker(highlights, NodeFilter.SHOW_TEXT)
    let node
    let offset = 0
    while (pos.length && (node = walker.nextNode())) {
      while (pos[0] >= offset && pos[0] < offset + node.length) {
        const range = document.createRange()
        range.setStart(node, pos[0] - offset)
        range.setEnd(node, pos[0] - offset + 1)
        const span = document.createElement('span')
        span.className = 'highlight ' + type
        range.surroundContents(span)
        pos.shift()
      }
      offset += node.length
    }
  }

  export function setSelection(start: number, end: number) {
    const wasFocused = document.activeElement.isSameNode(textarea)
    textarea.selectionStart = Math.max(start, 0)
    textarea.selectionEnd = Math.min(end, textarea.value.length)
    // on Safari, setting the selection can auto-focus so we have to blur
    if (!wasFocused) textarea.blur()
  }

  export function insertImages(create: boolean = false) {
    window['_modal']({
      content:
        window['_user'].uid == 'anonymous'
          ? 'Select images to insert. Since you are not signed in, images **will not be uploaded** and will be discarded when you close the page. Once you sign in, all uploads will be encrypted with your secret phrase, viewable **only by you, on your devices.**'
          : 'Select images to upload for insertion. Uploads are encrypted with your secret phrase, viewable **only by you, on your devices.**',
      images: true,
      confirm: 'Insert Images',
      cancel: 'Cancel',
      background: 'cancel',
      onCancel: () => {
        textarea.focus()
      },
      onConfirm: images => {
        // NOTE: devicePixelRatio is fixed in Safari but varies in Chrome based on page zoom level, which is not possible to detect reliably (e.g. the ratio outerWidth/innerWidth works only when console is not open)
        const zoom = Math.round(1000 / devicePixelRatio) / 1000
        const tags = images
          .map(image => {
            return zoom == 1.0 ? `<img src="${image.fname}">` : `<img src="${image.fname}" style="zoom:${zoom}">`
          })
          .join(' ')
        textarea.focus()
        document.execCommand('insertText', false, tags)
        onInput()
        if (create) onDone(text, { code: 'Enter' })
      },
    })
  }

  import { tick } from 'svelte'

  let enterStart = -1
  let enterIndentation = ''
  let lastKeyDown
  let lastKeyDownTime = 0
  let createClosure
  let createClosureModifierKeys

  function onKeyDown(e: any) {
    onEditorKeyDown(e)
    let key = e.code || e.key // for android compatibility
    if (!key) return // can be empty for pencil input on ios
    // console.debug('Editor.onKeyDown:', e, key)

    if (navigator.userAgent.toLowerCase().includes('android')) {
      // generic workaround for Shift-Enter not working on android keyboards: Space-then-Return-within-250ms w/o modifiers deletes the space and behaves like Shift+Enter
      if (
        key == 'Enter' &&
        ((lastKeyDown == 'Space' && Date.now() - lastKeyDownTime < 250) ||
          (lastKeyDown == 'Unidentified' &&
            lastInputInsertText?.endsWith(' ') &&
            Date.now() - lastInputInsertTextTime < 250)) &&
        !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) &&
        textarea.selectionStart == textarea.selectionEnd &&
        textarea.value[textarea.selectionStart - 1] == ' '
      ) {
        // Object.defineProperty(e, "shiftKey", { value: true });
        const caretPos = textarea.selectionStart // to restore after deletion
        textarea.value = textarea.value.slice(0, caretPos - 1) + textarea.value.slice(caretPos)
        textarea.selectionStart = textarea.selectionEnd = caretPos - 1
        e.preventDefault()
        e.stopPropagation()
        onDone((text = textarea.value), e)
        return
      }
      // workaround for "Windows" key on Hacker's Keyboard on android
      if (lastKeyDown == 'Meta') Object.defineProperty(e, 'metaKey', { value: true })
      lastKeyDown = key
      lastKeyDownTime = Date.now()
    }

    // ignore modifier keys, and otherwise stop propagation outside of editor
    // only keys we propagate are unmodified ArrowUp/Down at start/end of editor
    const modified = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey
    if (key.match(/^(Meta|Alt|Control|Shift)/)) return
    else if (propagateArrowUpDownAtEdges && key == 'ArrowUp' && !modified && textarea.selectionEnd == 0) return
    else if (
      propagateArrowUpDownAtEdges &&
      key == 'ArrowDown' &&
      !modified &&
      textarea.selectionStart == textarea.value.length
    ) {
      textarea.blur() // also remove focus to avoid confusion e.g. if there is a scroll down
      return
    } else e.stopPropagation()

    // reset create closure (see setup below)
    createClosure = createClosureModifierKeys = null

    // optionally disable Cmd/Ctrl bracket (commonly used as forward/back shortcuts) inside editor
    // TODO: figure out an alternative to this (also for RightArrow/LeftArrow) for iOS15 if necessary
    //       (same issue on MacOS w/ Ctrl+RightArrow/LeftArrow being captured by system unless reconfigured)
    if (!allowCommandCtrlBracket && (key == 'BracketLeft' || key == 'BracketRight') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      return
    }

    // disable Shift+Cmd+C which (usually accidentally) enables element targeting in Safari
    if (key == 'KeyC' && e.shiftKey && e.metaKey) {
      e.preventDefault()
      return
    }

    // disable Shift+Cmd/Ctrl+S, letting window handle it for "resume edit"
    if (key == 'KeyS' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault()
      return
    }

    // indent/comment selection or current line
    // NOTE: tab key will indent at bullet heads or when there is a selection
    // NOTE: an alternative is to indent anywhere on a bullet line
    //       (requires taking full current line, not just from current position)
    // const tabShouldIndent =
    //   (textarea.selectionStart == textarea.selectionEnd &&
    //   textarea.value.substring(0, textarea.selectionStart).match(/[-*+] $/)) ||
    //   textarea.selectionEnd > textarea.selectionStart;
    const tabShouldIndent = true // always indent
    if ((key == 'Tab' && tabShouldIndent) || (key == 'Slash' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault()
      const oldStart = textarea.selectionStart
      let oldEnd = textarea.selectionEnd
      let oldLength = textarea.value.length
      // move selection to line start
      let lineStart = textarea.value.substring(0, textarea.selectionStart).replace(/[^\n]*$/, '').length
      textarea.selectionStart = lineStart
      // expand selection to end of last line
      // if selection ends right after a new line, exclude the last line
      if (textarea.selectionEnd > textarea.selectionStart && textarea.value[textarea.selectionEnd - 1] == '\n')
        textarea.selectionEnd--
      let lastLineStart = textarea.value.substring(0, textarea.selectionEnd).replace(/[^\n]*$/, '').length
      let lineEnd = lastLineStart + textarea.value.substring(lastLineStart).match(/^[^\n]*/)[0].length
      textarea.selectionEnd = lineEnd

      // NOTE: execCommand maintains undo/redo history
      let selectedText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd)
      let caretOffset // custom caret offset for two-sided delimiter insertions (e.g. html comments)
      if (key == 'Slash') {
        // attempt to determine language type, default being html/markdown w/ <-- comment --> syntax
        let language
        for (const block of textarea.value.matchAll(blockRegExp(/\S*?/))) {
          if (block.index > textarea.selectionStart) break // already past selection
          if (block.index + block[0].length < textarea.selectionEnd) continue // not there yet
          language = block[2] // language is in second capture group
          break
        }
        language ??= 'markdown' // assume markdown as default language
        language = language.match(/^_?(\S+?)(?:_|$)/)?.pop() ?? language // trim prefix/suffix
        language = language.toLowerCase() // language is case-insensitive

        // for html, detect if we are inside a script or style block, and modify language accordingly
        if (language == 'html') {
          let last_tag
          textarea.value.substring(0, textarea.selectionStart).replace(
            /<\/?\w(?:"[^"]*"|[^>"])*?>/gs,
            skipEscaped(m => (last_tag = m))
          )
          if (last_tag.match(/<script.*?>/s)) language = 'javascript'
          else if (last_tag.match(/<[s]tyle.*?>/s)) language = 'css'
        }

        if (double_slash_comment_languages.has(language)) {
          selectedText = selectedText.match(/^\s*\/\//)
            ? selectedText.replace(/((?:^|\n)\s*)\/\/\s*/g, '$1')
            : selectedText.replace(/((?:^|\n)\s*)(.*)/g, '$1// $2')
        } else if (hash_comment_languages.has(language)) {
          selectedText = selectedText.match(/^\s*#/)
            ? selectedText.replace(/((?:^|\n)\s*)#\s*/g, '$1')
            : selectedText.replace(/((?:^|\n)\s*)(.*)/g, '$1# $2')
        } else if (html_comment_languages.has(language)) {
          // NOTE: technically multi-line html comments are allowed, but are not highlighted by highlightjs (causing confusion in editor), and would also require special-casing in preserve-line-breaks logic, so we comment individual lines for now for simplicity ...
          // if (selectedText.match(/^\s*<!--/) && selectedText.match(/-->\s*$/))
          //   selectedText = selectedText.replace(/^(\s*)<!--\s*/g, '$1').replace(/\s*-->(\s*)$/g, '$1')
          // else if (!selectedText.match(/^\s*<!--/) && !selectedText.match(/-->\s*$/))
          //   selectedText = selectedText.replace(/^(\s*)(.*)$/gs, '$1<!-- $2').replace(/^(.*)(\s*)$/gs, '$1 -->$2')
          if (selectedText.match(/^\s*<!--/))
            selectedText = selectedText.replace(/((?:^|\n)\s*)<!--\s*(.*?)\s*-->/g, '$1$2')
          else {
            const prev_length = selectedText.length
            selectedText = selectedText.replace(/((?:^|\n)\s*)(.*)/g, '$1<!-- $2 -->')
            caretOffset = ((selectedText.length - prev_length) * 5) / 9 // 5 of 9 chars are left delimiters
          }
        } else if (mathematica_comment_languages.has(language)) {
          if (selectedText.match(/^\s*\(\*/))
            selectedText = selectedText.replace(/((?:^|\n)\s*)\(\*\s*(.*?)\s*\*\)/g, '$1$2')
          else {
            const prev_length = selectedText.length
            selectedText = selectedText.replace(/((?:^|\n)\s*)(.*)/g, '$1(* $2 *)')
            caretOffset = ((selectedText.length - prev_length) * 3) / 6 // 3 of 6 chars are left delimiters
          }
        } else if (c_comment_languages.has(language)) {
          if (selectedText.match(/^\s*\/\*/))
            selectedText = selectedText.replace(/((?:^|\n)\s*)\/\*\s*(.*?)\s*\*\//g, '$1$2')
          else {
            const prev_length = selectedText.length
            selectedText = selectedText.replace(/((?:^|\n)\s*)(.*)/g, '$1/* $2 */')
            caretOffset = ((selectedText.length - prev_length) * 3) / 6 // 3 of 6 chars are left delimiters
          }
        } else if (percent_comment_languages.has(language)) {
          selectedText = selectedText.match(/^\s*%/)
            ? selectedText.replace(/((?:^|\n)\s*)%\s*/g, '$1')
            : selectedText.replace(/((?:^|\n)\s*)(.*)/g, '$1% $2')
        } else if (double_dash_comment_languages.has(language)) {
          selectedText = selectedText.match(/^\s*--/)
            ? selectedText.replace(/((?:^|\n)\s*)--\s*/g, '$1')
            : selectedText.replace(/((?:^|\n)\s*)(.*)/g, '$1-- $2')
        } else {
          alert(`unknown comment syntax for language '${language}'`)
        }
      } else if (key == 'Tab' && e.shiftKey) selectedText = selectedText.replace(/(^|\n)  /g, '$1')
      else selectedText = selectedText.replace(/(^|\n)/g, '$1  ')
      document.execCommand('insertText', false, selectedText)

      if (oldStart < oldEnd) {
        // restore expanded selection
        textarea.selectionStart = Math.min(lineStart, oldStart)
        textarea.selectionEnd = oldEnd + (textarea.value.length - oldLength)
      } else {
        // move forward
        textarea.selectionStart = textarea.selectionEnd = Math.max(
          lineStart,
          oldStart + (caretOffset ?? textarea.value.length - oldLength)
        )
      }
      onInput()
      return
    }

    // create/run with Cmd/Ctrl+S or Shift/Cmd/Ctrl+Enter
    // NOTE: onDone callback is delayed until all modifier keys are released in order to prevent modifiers from affecting behavior, e.g. for window.open
    if (createOnAnyModifiers) {
      if (
        (key == 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) ||
        (key == 'KeyS' && (e.metaKey || e.ctrlKey) && !e.shiftKey)
      ) {
        e.preventDefault()
        const run = key == 'Enter' && (e.metaKey || e.ctrlKey)
        createClosure = () => {
          onDone((text = textarea.value), e, false, run)
          createClosure = createClosureModifierKeys = null
        }
        createClosureModifierKeys = {
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
        }
      }
    } else {
      if (
        (key == 'Enter' && e.shiftKey && !(e.metaKey || e.ctrlKey)) ||
        (key == 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey))
      ) {
        e.preventDefault()
        const run = key == 'Enter' && (e.metaKey || e.ctrlKey)
        createClosure = () => {
          onDone((text = textarea.value), e, false, run)
          createClosure = createClosureModifierKeys = null
        }
        createClosureModifierKeys = {
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
        }
        return
      }

      // save item with Cmd/Ctrl+S
      if (key == 'KeyS' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault()
        onSave()
        return
      }

      // run item with Alt/Option+Enter
      // not to be confused w/ alt-modified "run" click (or backquote keydown) handled in index.svelte
      if (key == 'Enter' && e.altKey && !(e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        let selectionStart = textarea.selectionStart
        let selectionEnd = textarea.selectionEnd
        onRun()
        tick().then(() => {
          textarea.selectionStart = selectionStart
          textarea.selectionEnd = selectionEnd
        })
        return
      }
    }

    // create line on Enter, maintain indentation
    // NOTE: to prevent delay on caret update, we do the actual indentation in onKeyUp
    if (
      key == 'Enter' &&
      !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) &&
      textarea.selectionStart == textarea.selectionEnd
    ) {
      if (enterStart < 0) {
        enterStart = textarea.selectionStart
        enterIndentation = textarea.value.substring(0, textarea.selectionStart).match(/(?:^|\n)( *).*?$/)[1] || ''
      }
      return
    }

    if (key == 'ArrowUp' && e.metaKey && textarea.selectionEnd == 0) {
      e.preventDefault()
      onPrev()
      return
    }
    if (key == 'ArrowDown' && e.metaKey && textarea.selectionStart == textarea.value.length) {
      e.preventDefault()
      onNext()
      return
    }

    // remove spaced tabs (and optional bullet) with backspace
    // (for backspace, unlike shift-tab, we require/allow an _extra_ space and we require even number of spaces)
    const prefix = textarea.value.substring(0, textarea.selectionStart)
    if (
      key == 'Backspace' &&
      !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) &&
      textarea.selectionStart == textarea.selectionEnd &&
      textarea.selectionStart >= 2 &&
      prefix.match(/(?:^|\s)[-*+ ] $/) &&
      prefix.match(/ *[-*+ ] $/)[0].length % 2 == 0
    ) {
      textarea.selectionStart = textarea.selectionStart - 2
      // NOTE: forwardDelete seems to behave better on iOS, as "delete" can sometimes cause an additional whitespace to be deleted (e.g. move back to upper bullet in bullet list) for unknown reasons (even only it is not contained in the selection if we comment out the delete)
      document.execCommand('forwardDelete')
      e.preventDefault()
      onInput()
      return
    }

    // cancel edit with escape
    if (key == 'Escape') {
      e.preventDefault()
      if (!onEscape(e)) return // escape was handled, should be ignored
      onDone(text /* maintain text */, e, true /* cancelled */)
      return
    }

    // NOTE: this was too easy to trigger accidentally on mobile, so we limit it to search box
    // clear item (from current position to start) with shift-backspace
    if (key == 'Backspace' && e.shiftKey && textarea.selectionStart == textarea.selectionEnd) {
      e.preventDefault()
      if (clearOnShiftBackspace) {
        textarea.selectionStart = 0
        document.execCommand('forwardDelete')
        onInput()
      }
      return
    }

    // delete non-empty item with Cmd/Ctrl+Backspace
    // NOTE: Cmd-Backspace may be assigned already to "delete line" and overload requires disabling on key down
    if (key == 'Backspace' && (e.metaKey || e.ctrlKey)) {
      if (!cancelOnDelete) e._delete = true // use this flag instead of clearing text, which is hard to cancel
      onDone(text, e, cancelOnDelete) // if cancelled, item will not be deleted
      e.preventDefault()
      return
    }

    // insert spaces on Tab
    if (key == 'Tab' && textarea.selectionStart == textarea.selectionEnd) {
      e.preventDefault()
      if (!e.shiftKey) {
        // forward tab
        document.execCommand('insertText', false, '  ')
      } else if (
        textarea.selectionStart >= 2 &&
        textarea.value.substring(textarea.selectionStart - 2, textarea.selectionStart) == '  '
      ) {
        textarea.selectionStart = textarea.selectionStart - 2
        document.execCommand('forwardDelete')
      }
      onInput()
      return
    }

    // insert images on Alt+Cmd+i
    if (key == 'KeyI' && e.metaKey && e.shiftKey) {
      e.preventDefault()
      insertImages()
    }
  }

  function onKeyUp(e: any) {
    const key = e.code || e.key // for android compatibility
    if (!key) return // can be empty for pencil input on ios

    // console.debug('Editor.onKeyUp', e, key)

    // ignore modifier keys, and otherwise stop propagation outside of editor
    if (key.match(/^(Meta|Alt|Control|Shift)/)) {
      // clear createClosureModifierKeys and trigger createClosure when cleared
      if (createClosureModifierKeys) {
        if (key.match(/^Meta/)) createClosureModifierKeys.metaKey = false
        else if (key.match(/^Alt/)) createClosureModifierKeys.altKey = false
        else if (key.match(/^Control/)) createClosureModifierKeys.ctrlKey = false
        else if (key.match(/^Shift/)) createClosureModifierKeys.shiftKey = false
        if (
          !createClosureModifierKeys.metaKey &&
          !createClosureModifierKeys.altKey &&
          !createClosureModifierKeys.ctrlKey &&
          !createClosureModifierKeys.shiftKey
        ) {
          createClosure()
        }
      }
      return
    } else e.stopPropagation()

    // indent lines created by Enter (based on state recorded in onKeyDown above)
    if (
      key == 'Enter' &&
      !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) &&
      textarea.selectionStart == textarea.selectionEnd
    ) {
      if (enterStart >= 0) {
        // extend bullet points to new lines
        const bullet = textarea.value.substring(0, enterStart).match(/(?:^|\n) *([-*+] (?:\[[xX ]\] )?).*$/)
        if (bullet) enterIndentation += bullet[1]
        if (enterIndentation) {
          let offset = textarea.value
            .substring(textarea.selectionEnd)
            .match(/^[^\n]*/)[0]
            .trimEnd().length
          textarea.selectionEnd += offset
          let newlines = textarea.value.substring(enterStart, textarea.selectionEnd)
          newlines = newlines.replace(/\n([^\n]*)/g, (m, sfx) => {
            let trimmed_sfx = bullet ? sfx.replace(/^[-*+\s]*/, '') : sfx
            offset -= sfx.length - trimmed_sfx.length
            return '\n' + enterIndentation + trimmed_sfx
          })
          textarea.selectionStart = enterStart
          // NOTE: using execCommand maintains continuity of undo stack, even though it does create an extra undo step (with selection) that may be undesirable, mainly because we are handling Enter on key-up to maintain caret responsiveness on key-down; this seems relatively minor as long as continuity of undo is maintained
          // textarea.value = textarea.value.slice(0, enterStart) + newlines + textarea.value.slice(textarea.selectionEnd)
          document.execCommand('insertText', false, newlines)
          textarea.selectionStart = textarea.selectionEnd = textarea.selectionStart - offset
          onInput()
        }
        enterStart = -1
        enterIndentation = ''
      }
    }
  }

  function onPaste(e: ClipboardEvent) {
    e.preventDefault()
    e.stopPropagation()
    const data = e.clipboardData || e['originalEvent'].clipboardData
    // console.debug(Array.from(data.items).map((item: any) => item.type));
    Array.from(data.items).forEach((item: any) => {
      if (item.type == 'text/plain') {
        item.getAsString(text => {
          // copy bullet and indentation to subsequent lines
          let bullet
          if ((bullet = textarea.value.substring(0, textarea.selectionStart).match(/(?:^|\n)( *)([-*+] +)$/))) {
            text = text.replace(/(^|\n)( *[-*+] +)/g, '$1') // remove existing bullets
            text = text.replace(/(\n\s*)/g, '$1' + bullet[1] + bullet[2])
          }
          // replace tabs with double-space
          text = text.replace(/\t/g, '  ')
          // NOTE: on android getAsString causes a mysterious reset selectionStart->selectionEnd
          textarea.selectionStart = selectionStart // fix for android
          document.execCommand('insertText', false, text)
        })
      } else if (item.type.startsWith('image/') || item.type == 'application/pdf') {
        const file = item.getAsFile()
        const url = URL.createObjectURL(file)
        const zoom = Math.round(1000 / devicePixelRatio) / 1000 // see note above about devicePixelRatio
        const modal = window['_modal']('Inserting pasted image ...')
        Promise.resolve(
          onPastedImage(url, file, size => {
            window['_modal_update'](
              modal,
              `Inserting pasted image (${numberWithCommas(Math.ceil(size / 1024))} KB) ...`
            )
          })
        )
          .then(fname => {
            setTimeout(() => window['_modal_close'](modal), 0) // increase delay for testing
            const img = zoom == 1.0 ? `<img src="${fname}">` : `<img src="${fname}" style="zoom:${zoom}">`
            textarea.focus()
            textarea.selectionStart = selectionStart // fix for android (see note above)
            document.execCommand('insertText', false, img)
          })
          .catch(console.error)
      }
    })
  }

  let lastInputInsertText
  let lastInputInsertTextTime = 0
  function onInput(e = null) {
    onSelectionChange() // workaround for missing selectionchange events; see comment in onSelectionChange
    if (e?.inputType == 'insertText' || e?.inputType == 'insertCompositionText') {
      // to help disambiguate some "Unidentified" keys (e.g. "Space") for some android keyboards, in particular gboard which is said to do this to allow content-dependent "compositions", but this seems non-standard and requires further research
      // NOTE: this is a limited experiment and not extended to many other problematic keys, e.g. Enter, which seem to be content-sensitive (e.g. key is Enter after a space, but Unidentified otherwise)
      lastInputInsertText = e.data
      lastInputInsertTextTime = Date.now()
    }
    text = textarea.value // no trimming until onDone
    updateTextDivs()
    onEdited(textarea.value)
  }

  function onCreate(e) {
    e.stopPropagation()
    e.preventDefault()
    onDone(text, { code: 'Enter' })
  }

  function onClear(e) {
    e.stopPropagation()
    e.preventDefault()
    if (textarea.value) {
      if (focused) {
        textarea.selectionStart = 0
        textarea.selectionEnd = textarea.value.length
        document.execCommand('forwardDelete')
      } else {
        textarea.value = ''
      }
      onInput()
    }
  }

  function onImage(e) {
    e.stopPropagation()
    e.preventDefault()
    insertImages(!focused) // create new item if not focused
  }

  // function used to cancel click events below
  function cancel(e) {
    e.stopPropagation()
    e.preventDefault()
  }

  // backdrop click handler that allows us to dynamically hide/show textarea while editor is not focused (see textarea.focused style below), avoiding double-matching text for find-in-page (Cmd+F) in Chrome (and likely other browsers but not Safari as of last testing)
  function onBackdropClick(e) {
    e.stopPropagation()
    e.preventDefault()
    // determine text offset of clicked point in backdrop to move caret in textarea before focusing it
    const range = document.caretRangeFromPoint(e.clientX, e.clientY)
    range.startContainer
    const walker = document.createTreeWalker(backdrop, NodeFilter.SHOW_TEXT)
    let node
    let offset = 0
    while ((node = walker.nextNode())) {
      // console.debug(node.length, node)
      if (node.isSameNode(range.startContainer)) {
        offset += range.startOffset
        break
      }
      offset += node.length
    }
    textarea.selectionStart = textarea.selectionEnd = offset
    textarea.focus()
  }

  import { afterUpdate, onMount, onDestroy } from 'svelte'
  afterUpdate(() => {
    if (!textarea) return // can happen occasionally during destruction at end of editing
    updateTextDivs()
  })

  const highlightDebounceTime = 0
  let highlightPending = false
  function onSelectionChange() {
    // NOTE: onSelectionChange can get invoked repeatedly for multiple textareas on the page (e.g. mindbox editor and item editors) even though the focus is on a specific textarea and the selection is not really changing for other textareas. We can easily filter such spurious calls by filtering by document.activeElement and textarea.selectionStart/End. Another more important problem is that onSelectionChange may fail to get invoked in certain situations in a browser and content dependent way: e.g. tail newline insertions can fail in Safari, and newlines preceding tail spaces on nonempty lines can fail in Chrome). This latter issue we can work around by invoking onSelectionChange from onInput, which is of course harmless if selection has not changed.
    if (!document.activeElement.isSameNode(textarea)) return
    if (selectionStart == textarea.selectionStart && selectionEnd == textarea.selectionEnd) return
    // console.debug('onSelectionChange', textarea.selectionStart, textarea.selectionEnd)

    selectionStart = textarea.selectionStart
    selectionEnd = textarea.selectionEnd
    if (textarea.selectionStart != textarea.selectionEnd) return
    if (highlightPending) return
    highlightPending = true
    setTimeout(() => {
      highlightPending = false
      if (!highlights) return
      if (
        highlights.querySelector('span.highlight') ||
        (textarea.selectionStart > 0 &&
          textarea.selectionStart < text.length &&
          ')]}'.includes(textarea.value[textarea.selectionStart])) ||
        (textarea.selectionStart > 0 &&
          textarea.selectionStart < text.length &&
          '([{'.includes(textarea.value[textarea.selectionStart - 1]))
      ) {
        updateTextDivs()
      }
    }, highlightDebounceTime)
  }
  onMount(() => {
    // replace textarea.focus/ w/ custom method that sets .editor.focused
    // otherwise textarea can be invisible, preventing focus
    const _focus = textarea.focus
    textarea.focus = () => {
      if (!editor) return
      editor.classList.add('focused')
      _focus.call(textarea)
    }
    // set up listener for selection changes (does not capture all, see comment in onSelectionChange)
    document.addEventListener('selectionchange', onSelectionChange)
    // console.debug("onMount selection", selectionStart, selectionEnd);
    // check for data-selection attribute on container, consume if it exists
    const selectionAttrib = editor.closest('.container')?.getAttribute('data-selection')
    if (selectionAttrib) {
      ;[selectionStart, selectionEnd] = selectionAttrib.split(',').map(Number)
      editor.closest('.container').removeAttribute('data-selection') // consume attrib
    }
    setSelection(selectionStart, selectionEnd)
  })
  onDestroy(() => document.removeEventListener('selectionchange', onSelectionChange))
</script>

<div bind:this={editor} class="editor" class:focused>
  <div class="backdrop" class:focused bind:this={backdrop} on:click={onBackdropClick}>
    <div bind:this={highlights}>{placeholder}</div>
  </div>
  <textarea
    id={'textarea-' + id_suffix}
    bind:this={textarea}
    {placeholder}
    on:input={onInput}
    on:keydown={onKeyDown}
    on:keyup={onKeyUp}
    on:paste={onPaste}
    on:focus={() => onFocused((focused = true))}
    on:blur={() => onFocused((focused = false))}
    autocapitalize="off"
    {spellcheck}
    disabled={!editable}
    class:editable
    value={text}
  />
  {#if showButtons}
    <!-- we cancel the click at the parent (.buttons), which works if it doesn't shrink during the click -->
    <div class="buttons" class:focused on:click={cancel}>
      <!-- on:mousedown keeps focus on textarea and generally works better (e.g. allows us to refocus on iOS without going outside of scope of click handler) but we have to cancel subsequent click to avoid side effects (e.g. focus going back to editor after creating a new item) -->
      <div class="button create" on:mousedown={onCreate}>create</div>
      <div class="button image" on:mousedown={onImage}>+img</div>
      <div class="button clear" class:clearable={text.length} on:mousedown={onClear}>clear</div>
    </div>
  {/if}
</div>

<!-- update editor on window resize (height changes due to text reflow) -->
<svelte:window on:resize={updateTextDivs} />

<!-- update editor on window resize (height changes due to text reflow) -->
<style>
  .editor {
    position: relative;
    width: 100%;
    cursor: text;
  }
  .backdrop,
  textarea {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 300;
    font-size: 14px;
    line-height: 24px;
    caret-color: red;
    overflow: hidden;
  }
  .backdrop {
    /* color: transparent; */
    color: #ddd;
    width: 100%;
    background: #111;
    width: 100%;
    padding: 10px;
    border-radius: 4px;
    border: 1px dashed #444;
    box-sizing: border-box;
    white-space: pre-wrap;
    word-wrap: break-word;
    opacity: 0.9;
  }
  .editor.focused > .backdrop {
    background: #171717;
    border: 1px solid #444;
    opacity: 1;
  }
  textarea {
    position: absolute;
    top: 0;
    background: transparent;
    color: transparent;
    width: 100%;
    margin: 0;
    padding: 10px;
    outline: none;
    border-radius: 0;
    border: 1px solid transparent;
    padding-bottom: 0;
    box-sizing: border-box;
    display: block; /* removed additional space below, see https://stackoverflow.com/a/7144960 */
    resize: none;
    visibility: hidden; /* see onBackdropClick for comments */
  }
  .editor.focused > textarea {
    visibility: visible; /* see onBackdropClick for comments */
  }
  textarea:not(.editable) {
    cursor: auto; /* better for selection */
  }

  /* NOTE: increase selection transparency to allow backdrop highlights to show through */
  textarea::selection {
    color: transparent;
    background: rgb(255, 0, 0, 0.25);
  }
  textarea::-moz-selection {
    color: transparent;
    background: rgb(255, 0, 0, 0.25);
  }
  .buttons {
    position: absolute;
    top: -30px; /* -15px (touches browser bar), -15 for additional padding */
    right: -2px;
    color: black;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 15px;
    font-weight: 600;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
    border-radius: 5px;
    overflow: hidden;
  }
  .button {
    height: 23px;
    padding: 0 8px;
    padding-top: 15px;
    display: inline-flex;
    background: #999;
    cursor: pointer;
    align-items: center;
  }
  .button:not(:first-child) {
    border-left: 1px solid black;
  }
  .create {
    background: #7a7;
  }
  .clear:not(.clearable) {
    /* NOTE: display: none leaks click on "create" to #header as create button moves right */
    /* display: none; */
    background: #666;
    cursor: not-allowed;
  }
  .buttons:not(.focused) .image {
    display: none;
  }
  /* disable +img for now, seems unnecessary at the top */
  .image {
    display: none;
  }

  .editor > .backdrop :global(mark) {
    /* color: transparent; */
    background: #999;
    font-weight: 600; /* 500 looks light for Menlo w/ white background */
    border-radius: 4px;
    padding: 0 2px;
    margin: 0 -2px;
    cursor: pointer;
  }
  .editor > .backdrop :global(a) {
    color: #468;
  }
  .editor > .backdrop :global(.block) {
    background: rgba(0, 0, 0, 0.5);
    border-radius: 4px;
    padding: 1px;
    margin: -1px;
  }
  .editor > .backdrop :global(.block-delimiter) {
    color: #666;
  }
  .editor > .backdrop :global(:is(span.code, span.math)) {
    background: rgba(0, 0, 0, 0.5);
    padding: 2px 0; /* no overhang since delimited anyway */
    margin: -2px 0;
    border-radius: 4px;
  }
  .editor > .backdrop :global(.macro) {
    background: rgba(0, 0, 0, 0.5);
    border-radius: 4px;
  }
  .editor > .backdrop :global(.macro .macro-delimiter) {
    color: #89bdff; /* same as hljs-tag and also indicative of macroed/scripted/run/etc (blue) */
  }
  .editor > .backdrop :global(span.title) {
    padding: 2px 4px; /* overhang is fine since titles are on their own lines */
    margin: -2px -4px;
    background: rgba(255, 255, 255, 0.1);
    /* background: rgba(0, 0, 0, 0.9); */
    border-radius: 4px;
    font-weight: 700;
  }
  .editor > .backdrop :global(span.link) {
    padding: 2px 0; /* same as span.code, no overhang to avoid overlapping adjacent text */
    margin: -2px 0;
    /* background: #222; */
    background: rgba(0, 0, 0, 0.5);
    border-radius: 4px;
    color: #57b;
  }
  .editor > .backdrop :global(span.link > span.link) {
    color: #888;
    background: transparent;
  }
  .editor > .backdrop :global(.section) {
    border: 1px dashed #444;
    margin: -1px -5px;
    padding: 0 4px;
  }
  .editor > .backdrop :global(.section.agent) {
    border: none;
    margin: 0 -4px;
    background: #222;
  }
  /* .editor > .backdrop :global(.section-delimiter) {
    color: #666;
  } */
  .editor.focused > .backdrop :global(span.highlight.matched) {
    color: black;
    background: #9f9;
    /* border: 1px solid #9f9; */
    box-sizing: border-box;
    border-radius: 4px;
  }
  .editor.focused > .backdrop :global(span.highlight.unmatched) {
    color: black;
    background: #f99;
    /* border: 1px solid #f99; */
    box-sizing: border-box;
    border-radius: 4px;
  }

  .editor > .backdrop :global(.hljs-comment a) {
    color: #666; /* since not clickable in editor */
  }

  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    .backdrop,
    textarea {
      font-size: 11px;
      line-height: 20px;
    }
  }
</style>
