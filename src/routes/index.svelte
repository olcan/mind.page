<script lang="ts">
  import _ from 'lodash'
  // import localForage from "localforage";
  import { isClient, firebase, firestore } from '../../firebase.js'
  import { Circle2 } from 'svelte-loading-spinners'
  import Modal from '../components/Modal.svelte'
  import Editor from '../components/Editor.svelte'
  import Item from '../components/Item.svelte'
  export let items = []
  export let items_preload = [] // items returned by server preload (see above and server.ts)
  export let error = null
  let user = null
  let deletedItems = []
  let editingItems = []
  let focusedItem = -1
  let editorFocused = false
  let focused = false
  let signedin = false
  let admin = false
  let anonymous = false
  let readonly = false
  let zoom = isClient && localStorage.getItem('mindpage_zoom')
  let inverted = isClient && localStorage.getItem('mindpage_inverted') == 'true'
  let narrating = isClient && localStorage.getItem('mindpage_narrating') != null
  let green_screen = isClient && localStorage.getItem('mindpage_green_screen') == 'true'
  if (isClient) window['_green_screen'] = green_screen
  let intro = true // larger centered narration window
  let modal

  let evalStack = []
  function addLineNumbers(code) {
    let lineno = 1
    return code
      .split('\n')
      .map(line => `/*${lineno++}*/ ${line}`)
      .join('\n')
  }

  function update_dom() {
    return new Promise(resolve => {
      // skip animation frame to ensure DOM is updated for running=true
      // (otherwise only option is an arbitrary delay since polling DOM does not work)
      // (see https://stackoverflow.com/a/57659371 and other answers to that question)
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })
  }

  // returns item with name (unique label)
  // returns null if missing, or if multiple items match label
  // logs errors to console.error unless log_errors=false
  function _item(name: string, log_errors = true): any {
    if (!name) return null
    let item
    if (name.startsWith('#')) {
      // item is specified by unique label (i.e. name)
      const ids = idsFromLabel.get(name.toLowerCase())
      if (!ids || ids.length == 0) {
        if (log_errors) console.error(`_item '${name}' not found`)
        return null
      } else if (ids.length > 1) {
        if (log_errors) console.error(`_item '${name}' is ambiguous (${ids.length} items)`)
        return null
      }
      item = items[indexFromId.get(ids[0])]
    } else {
      // item is specified by id, with optional id: prefix to be dropped
      const index = indexFromId.get(name.startsWith('id:') ? name.substring(3) : name)
      if (index === undefined) {
        if (log_errors) console.error(`_item '${name}' not found`)
        return null
      }
      item = items[index]
    }
    return Object.freeze(new _Item(item.id)) // defined below
  }

  // same as _item, but for existence checks, and allows multiple matches
  function _exists(name: string, allow_multiple = true): any {
    if (!name) return false
    if (name.startsWith('#')) {
      // label
      const ids = idsFromLabel.get(name.toLowerCase())
      return allow_multiple ? ids?.length > 0 : ids?.length == 1
    } else {
      // id
      const index = indexFromId.get(name.startsWith('id:') ? name.substring(3) : name)
      return index !== undefined
    }
  }

  // _items returns any number of matches, most recent first
  function _items(label: string = '') {
    const ids = (label ? idsFromLabel.get(label.toLowerCase()) : items.map(item => item.id)) || []
    return _.sortBy(
      ids.map(id => _item(id)),
      item => -item.time
    )
  }

  // _labels returns labels in use, optionally filtered by selector (label,ids):boolean
  function _labels(selector = null) {
    if (!selector) return Array.from(idsFromLabel.keys())
    let matches = []
    for (const [label, ids] of idsFromLabel.entries()) if (selector(label, ids)) matches.push(label)
    return matches
  }

  // _sublabels returns all labels (in use) that are nested under given parent label
  function _sublabels(parent: string) {
    let prefix = parent
    if (!prefix.startsWith('#')) prefix = '#' + prefix
    if (!prefix.endsWith('/')) prefix = prefix + '/'
    return _labels(label => label.length > prefix.length && label.startsWith(prefix)).map(label =>
      label.slice(prefix.length)
    )
  }

  // _hash returns a fast hash of given string, array, object, etc
  function _hash(x, stringifier = JSON.stringify) {
    if (x?._hash) return x._hash
    if (typeof x == 'undefined') return undefined
    if (typeof x == 'function') return hashCode('' + x)
    if (typeof x == 'string') return hashCode(x)
    return hashCode(stringifier(x))
  }

  // _modal shows a modal dialog
  function _modal(options) {
    return modal.show(options)
  }

  // _modal_close closes modal manually
  function _modal_close(out = undefined) {
    return modal.close(out)
  }

  // _modal_update updates existing modal without closing it
  function _modal_update(options) {
    return modal.update(options)
  }

  // _modal_visible returns true iff modal is visible
  function _modal_visible() {
    return modal.isVisible()
  }

  // _delay is just setTimeout wrapped in a promise
  function _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // define window properties and functions
  if (isClient) {
    Object.defineProperty(window, '_user', {
      get: () =>
        !user
          ? null
          : {
              email: user.email,
              name: user.displayName?.match(/^\S*/)[0] || user.email,
              full_name: user.displayName || user.email,
              image_url: user.photoURL,
              image: `<img src="${user.photoURL}" style="width:20px;height:20px;border-radius:50%">`,
              uid: user.uid,
              total_text_length: textLength,
              total_text_length_string: numberWithCommas(textLength),
              oldest_item_time: oldestTime,
              oldest_item_time_string: oldestTimeString,
            },
    })
    Object.defineProperty(window, '_stack', { get: () => evalStack.slice() }) // return copy not reference
    Object.defineProperty(window, '_this', { get: () => _item(evalStack[evalStack.length - 1]) })
    Object.defineProperty(window, '_that', { get: () => _item(evalStack[0]) })
    window['_item'] = _item
    window['_items'] = _items
    window['_exists'] = _exists
    window['_labels'] = _labels
    window['_sublabels'] = _sublabels
    window['_hash'] = _hash
    window['_modal'] = _modal
    window['_modal_close'] = _modal_close
    window['_modal_update'] = _modal_update
    window['_modal_visible'] = _modal_visible
    window['_delay'] = _delay
    window['_update_dom'] = update_dom
    window['_decrypt_item'] = decryptItem
    window['_parse_tags'] = parseTags
    window['_parse_label'] = parseLabel
    window['_resolve_tags'] = resolveTags
    window['_special_tag'] = isSpecialTag
  }

  // private function for looking up item given its id
  // (throws "deleted" error if item has been deleted)
  function item(id: string) {
    const index = indexFromId.get(id)
    if (index === undefined) throw new Error(`item ${id} deleted`)
    return items[index]
  }
  const __item = item // alternative naming in case item is used to refer to a specific item

  const log_levels = ['debug', 'info', 'log', 'warn', 'error']

  class _Item {
    id: string
    constructor(id) {
      this.id = id
      // define _own_ _enumerable_ properties (e.g. for JSON.stringify)
      // https://stackoverflow.com/a/57179513
      for (const property of ['name']) {
        const descriptor = Object.getOwnPropertyDescriptor(_Item.prototype, property)
        const modified_descriptor = Object.assign(descriptor, { enumerable: true })
        Object.defineProperty(this, property, modified_descriptor)
      }
    }
    // getters
    get name(): string {
      return item(this.id).name
    }
    get label(): string {
      return item(this.id).labelText // case-sensitive label
    }
    get time(): number {
      return item(this.id).time
    }
    get attr(): object {
      return item(this.id).attr
    }
    get text(): string {
      return item(this.id).text
    }
    get length(): number {
      return item(this.id).text.length
    }
    get hash(): number {
      return item(this.id).hash
    }
    get deephash(): number {
      return item(this.id).deephash
    }
    get async(): boolean {
      return item(this.id).async
    }
    get deepasync(): boolean {
      return item(this.id).deepasync
    }
    get index(): number {
      return item(this.id).index
    }
    get position(): number {
      return item(this.id).index + 1
    }
    get tags(): Array<string> {
      return item(this.id).tags
    }
    get tags_raw(): Array<string> {
      return item(this.id).tagsRaw
    }
    get tags_visible(): Array<string> {
      return item(this.id).tagsVisible
    }
    get tags_hidden(): Array<string> {
      return item(this.id).tagsHidden
    }
    get dependencies(): Array<string> {
      return item(this.id).deps
    }
    get dependents(): Array<string> {
      return item(this.id).dependents
    }
    get saved_id(): number {
      return item(this.id).savedId
    }
    get editable(): boolean {
      return item(this.id).editable
    }
    set editable(editable: boolean) {
      const _item = item(this.id)
      if (_item.editable == editable) return // no change
      _item.editable = editable
      items = items // trigger svelte render
    }
    get pushable(): boolean {
      return item(this.id).pushable
    }
    set pushable(pushable: boolean) {
      const _item = item(this.id)
      if (_item.pushable == pushable) return // no change
      _item.pushable = pushable
      // items = items // trigger svelte render
      onEditorChange(editorText) // trigger re-ranking since pushability can affect it
    }
    get source(): string {
      return item(this.id).source
    }
    set source(source: string) {
      item(this.id).source = source
      items = items // trigger svelte render
    }
    get elem(): HTMLElement {
      // NOTE: we return the super-container as it is available even when editing
      // return document.getElementById("item-" + this.id);
      return document.getElementById('super-container-' + this.id)
    }
    // log options for write_log and write_log_any, reset in eval()
    get log_options(): object {
      const _item = item(this.id)
      if (!_item.log_options) _item.log_options = {}
      return _item.log_options
    }
    // general-purpose key-value store with session/item lifetime
    get store(): object {
      let _item = item(this.id)
      if (!_item.store) _item.store = {}
      return _item.store
    }

    // general-purpose cache object, cleared automatically if deephash has changed
    // NOTE: automated clearing is only during access via item.cache
    get cache(): object {
      const _item = item(this.id)
      if (_item.cache_deephash == this.deephash) return _item.cache
      _item.cache_deephash = this.deephash
      return (_item.cache = {})
    }

    // returns cached property, (re)computing value as needed
    cached(key, value_function) {
      const cache = this.cache as any
      return cache[key] ?? (cache[key] = value_function(this))
    }

    // invalidates cache object, to be cleared on next access via item.cache
    invalidate_cache() {
      const _item = item(this.id)
      if (_item.cache) delete _item.cache_deephash
    }

    // validates cache object for current deephash
    // effectively ignores changes between cache_deephash -> this.deephash
    validate_cache() {
      const _item = item(this.id)
      if (_item.cache) _item.cache_deephash = this.deephash
    }

    // "local" key-value store backed by localStorage
    // dispatches call to save_local_store to auto-save any synchronous changes
    // e.g. item.local_store.hello = "hello world" // saved automatically
    get local_store(): object {
      let _item = item(this.id)
      // until item is saved, we can only initialize and return in-memory store
      if (!_item.savedId) {
        setTimeout(() => this.save_local_store())
        return _item.local_store || (_item.local_store = {})
      }
      const key = 'mindpage_item_store_' + _item.savedId
      if (!_item.local_store) _item.local_store = JSON.parse(localStorage.getItem(key)) || {}
      // dispatch save for synchronous changes
      setTimeout(() => this.save_local_store())
      return _item.local_store
    }

    // saves item.local_store to localStorage
    // removes from localStorage if item or item.local_store is missing, or if object is empty
    // saving changes to local_store triggers re-render in case rendering is affected
    save_local_store() {
      let _item = item(this.id)
      // retry every second until item is saved
      if (!_item.savedId) {
        setTimeout(() => this.save_local_store(), 1000)
        return
      }
      const key = 'mindpage_item_store_' + _item.savedId
      const modified = !_.isEqual(_item.local_store, JSON.parse(localStorage.getItem(key)) || {})
      if (modified) this.invalidate_elem_cache(true /*force_render*/)
      if (_.isEmpty(_item.local_store)) localStorage.removeItem(key)
      else if (modified) localStorage.setItem(key, JSON.stringify(_item.local_store))
    }

    // "global" key-value store backed by firebase via hidden items named "global_store_<id>"
    // dispatches call to save_global_store to auto-save any synchronous changes
    // e.g. item.global_store.hello = "hello world" // saved automatically
    // redirects to local_store._anonymous_global_store for anonymous user
    get global_store(): object {
      let _item = item(this.id)
      // until item is saved, we can only initialize and return in-memory store
      if (!_item.savedId) {
        setTimeout(() => this.save_global_store())
        return _item.global_store || (_item.global_store = {})
      }
      if (anonymous) {
        if (!_item.global_store) _item.global_store = this.local_store['_anonymous_global_store'] || {}
        setTimeout(() => this.save_global_store())
        return _item.global_store
      }
      const name = 'global_store_' + _item.savedId
      if (!_item.global_store) _item.global_store = _.cloneDeep(hiddenItemsByName.get(name)?.item) || {}
      // dispatch save for any synchronous changes
      setTimeout(() => this.save_global_store())
      return _item.global_store
    }

    // saves item.global_store to firebase
    // deletes from firebase if item or item.global_store is missing, or if object is empty
    // saving changes to global_store triggers re-render in case rendering is affected
    // redirects to save_local_store() for anonymous user
    save_global_store() {
      let _item = item(this.id)
      // retry every second until item is saved
      if (!_item.savedId) {
        setTimeout(() => this.save_global_store(), 1000)
        return
      }
      if (anonymous) {
        if (_.isEmpty(_item.global_store)) delete this.local_store['_anonymous_global_store']
        else this.local_store['_anonymous_global_store'] = _item.global_store
        return
      }
      const name = 'global_store_' + _item.savedId
      const modified = !_.isEqual(_item.global_store, hiddenItemsByName.get(name)?.item || {})
      if (modified) this.invalidate_elem_cache(true /*force_render*/)
      if (_.isEmpty(_item.global_store)) deleteHiddenItem(hiddenItemsByName.get(name)?.id)
      else if (modified) saveHiddenItem(name, _.cloneDeep(_item.global_store))
    }

    // separate store used for debugging
    get debug_store(): object {
      let _item = item(this.id)
      if (!_item.debug_store) _item.debug_store = {}
      return _item.debug_store
    }

    read(type: string = '', options: object = {}) {
      const item = items[this.index]
      let content = []
      // include dependencies in order, _before_ item itself
      if (options['include_deps']) {
        options = _.merge({}, options, { include_deps: false }) // deps are recursive already
        item.deps.forEach(id => {
          const dep = items[indexFromId.get(id)]
          // NOTE: we allow async dependents to be excluded so that "sync" items can still depend on async items for auto-updating or non-code content or to serve as a mix of sync/async items that can be selectively imported
          if (options['exclude_async_deps'] && dep.deepasync) return // exclude async dependency chain
          content.push(_item(id).read(type, options))
        })
      }
      // indicate item name in comments for certain types of reads
      if (type == 'js' || type == 'webppl') content.push(`/* ${type} @ ${item.name} */`)
      else if (type == 'html') content.push(`<!-- ${type} @ ${item.name} -->`)
      let text = type ? extractBlock(item.text, type, options['keep_empty_lines']) : item.text
      if (options['replace_ids']) text = text.replace(/(^|[^\\])\$id/g, '$1' + item.id)
      if (!options['exclude_async'] || !item.deepasync) content.push(text)
      // console.debug(content);
      return content.filter(s => s).join('\n')
    }

    // "deep read" function with include_deps=true as default
    read_deep(type: string, options: object = {}) {
      return this.read(type, Object.assign({ include_deps: true }, options))
    }

    // read function intended for reading *_input blocks with code prefix
    read_input(type: string, options: object = {}) {
      return [
        this.read_deep(type, Object.assign({ replace_ids: true }, options)),
        this.read(type + '_input', options),
      ].join('\n')
    }

    // accessor for console log associated with item
    // levels are listed below, default level ("info") excludes debug messages
    // since can be "run" (default), "eval", or any epoch time (same as Date.now)
    // item can be "self" (default), specific item name (label or id), or "any"
    get_log(options = {}) {
      let since = options['since'] || 'run'
      if (since == 'run') since = item(this.id).lastRunTime
      else if (since == 'eval') since = item(this.id).lastEvalTime
      else if (typeof since != 'number') {
        console.error(`get_log: invalid since time '${since}', should be "run", "eval", or number (ms since epoch)`)
        return []
      }
      const level = log_levels.indexOf(options['level'] || 'info')
      if (level < 0) {
        console.error(`get_log: invalid level '${options['level']}', should be one of: ${log_levels}`)
        return []
      }
      const name = options['item'] || 'self'
      if (name != 'self' && name != 'any' && !item(name)) {
        console.error(`get_log: item '${name}' not found`)
        return []
      }
      const filter = options['filter']
      if (filter !== undefined && typeof filter != 'function') {
        console.error(
          `get_log: invalid filter '${filter}', should be function(entry) and return true|false to accept|reject entries with fields {time,level,stack,type,text}`
        )
        return []
      }
      let log = []
      const filter_id = name == 'self' ? this.id : name == 'any' ? '' : item(name).id
      for (let i = consoleLog.length - 1; i >= 0; --i) {
        const entry = consoleLog[i]
        if (entry.time < since) break
        if (entry.level < level) continue
        if (filter_id && !entry.stack.includes(filter_id)) continue
        if (filter && !filter(entry)) continue
        let prefix = entry.type == 'log' ? '' : entry.type.toUpperCase() + ': '
        if (prefix == 'WARN: ') prefix = 'WARNING: '
        log.push(prefix + entry.text)
      }
      return log.reverse()
    }

    write(text: string, type: string = '_output', options = {}) {
      text = typeof text == 'string' ? text : '' + JSON.stringify(text)
      // confirm if write is too big
      const writeConfirmLength = 64 * 1024
      if (text.length >= writeConfirmLength) {
        if (!confirm(`Write ${text.length} bytes (${type}) into ${this.name}?`)) return // cancel write
      }
      // maintain selection on textarea if editing and textarea is available (may not be for newly created item)
      if (item(this.id)?.editing) {
        let textarea = textArea(item(this.id).index)
        if (textarea) {
          let selectionStart = textarea.selectionStart
          let selectionEnd = textarea.selectionEnd
          tick().then(() => {
            let textarea = textArea(indexFromId.get(this.id))
            if (!textarea) return
            textarea.selectionStart = selectionStart
            textarea.selectionEnd = selectionEnd
          })
        }
      }
      // if writing *_log, clear any existing *_log blocks
      // (and skip write if block is empty)
      let __item = item(this.id) // writeable item
      if (type.endsWith('_log')) {
        __item.text = removeBlock(this.text, '\\w*?_log') // remove existing *_log
        if (text) __item.text = appendBlock(this.text, type, text) // if empty, skip
      } else {
        if (type.trim() == '') __item.text = text
        else __item.text = appendBlock(this.text, type, text)
      }
      if (!__item.log && !options['keep_time']) __item.time = Date.now()
      itemTextChanged(this.index, this.text, true, true, options['keep_time'])
      // dispatch onEditorChange to prevent index changes during eval
      setTimeout(() => {
        lastEditorChangeTime = 0 // disable debounce even if editor focused
        onEditorChange(editorText) // item time/text has changed
        // if (!item(this.id)?.editing) saveItem(this.id);
        saveItem(this.id)
      })
    }

    clear(type: string) {
      if (!type) throw new Error('clear(type) requires block type')
      item(this.id).text = clearBlock(this.text, _.escapeRegExp(type))
    }

    remove(type: string) {
      if (!type) throw new Error('remove(type) requires block type')
      item(this.id).text = removeBlock(this.text, _.escapeRegExp(type))
    }

    // deletes item
    // may be subject to confirmation by user
    // returns true if deleted, false if declined/cancelled
    delete() {
      return deleteItem(this.index)
    }

    write_log(options = {}) {
      options = _.merge(
        {
          since: 'run',
          level: 'info',
          type: '_log',
          item: 'self',
        },
        item(this.id).log_options, // may be undefined
        options
      )
      this.write(this.get_log(options).join('\n'), options['type'])
      if (options['type'] == '_log' || options['show_logs']) this.show_logs()
    }

    write_log_any(options = {}) {
      return this.write_log(Object.assign({ item: 'any' }, item(this.id).log_options, options))
    }

    show_logs(autohide_after: number = 15000) {
      itemShowLogs(this.id, autohide_after)
    }

    // "touches" item by updating its time
    // if save=false, change is not saved, a.k.a. "soft touch"
    // NOTE: this does not respect #log items, so any relevant checks must be done externally
    touch(save = false) {
      item(this.id).time = Date.now()
      lastEditorChangeTime = 0 // force immediate update
      onEditorChange(editorText) // item time has changed
      if (save) saveItem(this.id)
    }

    // triggers a save to persistent store, even if item is not modified
    save() {
      saveItem(this.id)
    }

    // evaluates given code in context of this item
    eval(evaljs: string = '', options: object = {}) {
      initItems() // initialize items if not already done, usually due to macros at first render

      // no wrapping or context prefix in debug mode (since already self-contained and wrapped)
      if (!options['debug']) {
        // apply _returning_ wrapper for evaljs for additional scoping
        // this is an inner wrapper that excludes any context prefix (see below for outer wrapper)
        // we attempt to insert return to last returnable (+balanced) expression to maintain ~eval semantics
        // NOTE: we can be conservative about returns since can be added manually if missed here
        function count_unescaped(str, substr) {
          if (substr.length == 0) throw 'substr can not be empty'
          let count = 0
          let pos = 0
          while ((pos = str.indexOf(substr, pos)) >= 0) {
            if (str[pos - 1] != '\\') count++
            pos += substr.length
          }
          return count
        }
        const expr_balanced = expr =>
          count_unescaped(expr, '`') % 2 == 0 &&
          count_unescaped(expr, "'") % 2 == 0 &&
          count_unescaped(expr, '"') % 2 == 0 &&
          count_unescaped(expr, '/*') == count_unescaped(expr, '*/') &&
          count_unescaped(expr, '{') == count_unescaped(expr, '}') &&
          count_unescaped(expr, '[') == count_unescaped(expr, ']') &&
          count_unescaped(expr, '(') == count_unescaped(expr, ')')

        const expr_returnable = expr =>
          // check for reserved keywords, see https://www.w3schools.com/js/js_reserved.asp
          // NOTE: we include ALL reserved words except true|false|null|undefined|new|this|await|typeof which are obviously sensible
          // NOTE: some of these keywords passed the variable name test ("let X = 0"), but we include them anyway; these were: (abstract|await|boolean|byte|char|double|final|float|goto|int|long|native|short|synchronized|throws|transient|volatile)
          // NOTE: any variable can still be returned by wrapping in parentheses, e.g. (goto)
          !expr.match(
            /^(?:\s*[})\].,:]|(?:abstract|arguments|boolean|break|byte|case|catch|char|class|const|continue|debugger|default|delete|do|double|else|enum|eval|export|extends|final|finally|float|for|function|goto|if|implements|import|in|instanceof|int|interface|let|long|native|package|private|protected|public|return|short|static|super|switch|synchronized|throw|throws|transient|try|var|void|volatile|while|with|yield)(?:\W|$))/
          )

        // do not insert return if js ends with a semicolon
        if (!evaljs.match(/;\s*$/)) {
          // first try to insert return at partial-line (semicolon) level ...
          // regex looks for last semicolon OR _unindented_ new line OR whole js code block
          // regex takes any whitespace into prefix so it does not split return statement
          // then we check expression for being balanced+returnable
          let try_lines // try full lines below?
          evaljs = evaljs.replace(/(.*(?:\n(?! )|;|^)\s*)(.+?)$/s, (m, pfx, expr) => {
            if (!expr_balanced(expr)) {
              // if not balanced, try finding an expression at line level (see below)
              try_lines = true
              return pfx + expr
            }
            return pfx + (expr_returnable(expr) ? 'return ' : '') + expr
          })
          if (try_lines) {
            // same as above, except exclude semicolons in regex (i.e. lines only)
            // also try expanding expression to include lines above to balance expression
            const try_last_line = (js, lines_below = '') =>
              js.replace(/(.*(?:\n(?! )|^)\s*)(.+?)$/s, (m, pfx, expr) => {
                expr += lines_below
                if (!expr_balanced(expr)) try_last_line('' + pfx, '' + expr)
                else evaljs = pfx + (expr_returnable(expr) ? 'return ' : '') + expr
                return m
              })
            try_last_line(evaljs) // modifies evaljs directly
          }
        }
        const async = options['async']
        evaljs = [`return (${async ? 'async ' : ''}() => {`, evaljs, '})()'].join('\n')

        // prepend context prefix (if not excluded)
        if (!options['exclude_prefix']) {
          let prefix = this.read_deep(
            options['type'] || 'js',
            // NOTE: by default, async deps are excluded unless async:true in options
            //       this affects ALL default eval, including e.g. 'macro_*' evals (see Item.svelte)
            //       notable exceptions are async 'run' and async 'command' evals
            Object.assign({ replace_ids: true, exclude_async_deps: !options['async'] }, options)
          )
          evaljs = [prefix, evaljs].join(';\n').trim()
        }

        if (async) {
          // async wrapper
          if (options['async_simple']) {
            // use light-weight wrapper without output/logging into item
            evaljs = ['(async () => {', evaljs, '})()'].join('\n')
          } else evaljs = ['_this.start(async () => {', evaljs, '}) // _this.start'].join('\n')
        } else {
          // sync wrapper
          // wrap evaljs in anonymous function for scoping AND performance
          // e.g. benchmark(()=>Math.random()) is 10-20x faster with this wrapper
          evaljs = ['(() => {', evaljs, '})()'].join('\n')
        }

        if (options['trigger']) evaljs = [`const __trigger = '${options['trigger']}';`, evaljs].join('\n')
        evaljs = ["'use strict';undefined;", `const _id = '${this.id}';`, 'const _this = _item(_id);', evaljs].join(
          '\n'
        )
      }

      // evaluate inline @{eval_macros}@
      let macroIndex = 0
      const replaceMacro = (m, pfx, js) => {
        try {
          let out = this.eval(js, {
            trigger: 'eval_macro_' + macroIndex++,
            exclude_prefix: true /* avoid infinite recursion */,
          })
          // If output is an item, read(*_macro) by default, where * is the prefix type
          // (using _macro suffix allow item to be a dependency without importing same code as prefix)
          if (out instanceof _Item) out = out.read_deep((options['type'] || 'js') + '_macro')
          return pfx + out
        } catch (e) {
          console.error(`eval_macro error in item ${this.label || 'id:' + this.id}: ${e}`)
          throw e
        }
      }
      // evaljs = evaljs.replace(/(^|[^\\])<<(.*?)>>/g, replaceMacro);
      evaljs = evaljs.replace(/(^|[^\\])@\{(.*?)\}@/g, replaceMacro)

      // replace any remaining $id, $hash, $deephash, just like in macros or _html(_*) blocks
      evaljs = evaljs.replace(/(^|[^\\])\$id/g, '$1' + this.id)
      evaljs = evaljs.replace(/(^|[^\\])\$hash/g, '$1' + this.hash)
      evaljs = evaljs.replace(/(^|[^\\])\$deephash/g, '$1' + this.deephash)
      if (options['cid']) evaljs = evaljs.replace(/(^|[^\\])\$cid/g, '$1' + options['cid'])

      // store eval text under item.debug_store[trigger] for debugging, including a reverse stack string
      let stack = evalStack
        .map(id => item(id).name)
        .concat(this.name)
        .reverse()
        .join(' < ')
      this.debug_store[options['trigger'] || 'other'] = appendBlock(
        `\`eval(…)\` on ${stack}`,
        'js_input',
        addLineNumbers(evaljs)
      )
      // run eval within try/catch block
      item(this.id).lastEvalTime = Date.now()
      if (options['trigger'] == 'run') {
        item(this.id).lastRunTime = Date.now()
        item(this.id).log_options = null
      }
      evalStack.push(this.id)
      try {
        const out = eval.call(window, evaljs)
        if (evalStack.pop() != this.id) console.error('invalid stack')
        return out
      } catch (e) {
        console.error(e)
        this.invalidate_elem_cache()
        if (evalStack.pop() != this.id) console.error('invalid stack')
        throw e
      }
    }

    // starts an async evaluation in context of this item
    // item is NOT on stack unless added explicitly (see below)
    // log messages are NOT associated with item while it is off the stack
    // _this is still defined in lexical context as if item is top of stack
    // returns promise resolved/rejected once evaluation is done (w/ output) or triggers error
    start(async_func) {
      item(this.id).running = true
      return new Promise((resolve, reject) => {
        update_dom().then(() =>
          Promise.resolve(async_func())
            .then(output => {
              if (output !== undefined) this.write(output)
              this.write_log_any() // customized via _this.log_options
              item(this.id).running = false
              resolve(output)
            })
            .catch(e => {
              console.error(e)
              this.invalidate_elem_cache()
              this.write_log_any() // customized via _this.log_options
              item(this.id).running = false
              reject(e)
            })
        )
      })
    }

    // invokes given (sync) function after pushing item onto stack
    // re-returns any return value, rethrows (after logging) any errors
    invoke(func) {
      evalStack.push(this.id)
      try {
        let out = func()
        // if function returns promise, attach it and set up default rejection handler
        if (out instanceof Promise) {
          out = this.attach(out).catch(e => {
            console.error(e)
            this.invalidate_elem_cache()
          })
        }
        if (evalStack.pop() != this.id) console.error('invalid stack')
        return out
      } catch (e) {
        console.error(e)
        this.invalidate_elem_cache()
        if (evalStack.pop() != this.id) console.error('invalid stack')
        throw e
      }
    }

    // "attaches" given function or promise to item such that it will go through _this.invoke()
    // promises are wrapped to auto-attach any functions passed to then/catch/finally
    attach(thing: any) {
      if (thing instanceof Promise) {
        const promise = thing
        const _item = this // for use in functions below
        promise.then = function (onFulfilled, onRejected) {
          // if (!onRejected) onRejected = console.error; // log errors by default
          return _item.attach(Promise.prototype.then.call(this, _item.attach(onFulfilled), _item.attach(onRejected)))
        }
        // Promise.catch internally calls Promise.then(undefined, onRejected) so no need to double-wrap
        // promise.catch = function (onRejected) {
        //   return _item.attach(Promise.prototype.catch.call(this, _item.attach(onRejected)));
        // };
        promise.finally = function (onFinally) {
          return _item.attach(Promise.prototype.finally.call(this, _item.attach(onFinally)))
        }
        return promise
      } else if (typeof thing == 'function') {
        const func = thing
        return ((...args) => {
          this.invoke(() => func(...args))
        }).bind(this)
      } else {
        return thing // return as is
      }
    }

    // dispatch = setTimeout on attached function
    dispatch(func, delay_ms = 0) {
      setTimeout(this.attach(func), delay_ms)
    }

    // dispatches function as a named task that can be cancelled or repeated
    // if repeat_ms>0, repeats function as long as item is not deleted
    // cancels any previously dispatched task under given name
    // cancels task if function returns null or throws error
    // function can be async or return promise
    dispatch_task(name, func, delay_ms = 0, repeat_ms = 0) {
      const task = () => {
        if (!_exists(this.id)) return // item deleted
        const _item = item(this.id)
        if (_item.tasks[name] != task) return // task cancelled or replaced
        try {
          this.resolve(func())
            .then(out => {
              if (out === null) {
                delete _item.tasks[name]
                return
              }
              if (repeat_ms > 0) this.dispatch(task, repeat_ms) // dispatch repeat
            })
            .catch(e => {
              console.error(`stopping task '${name}' due to error: ${e}`)
              return
            })
        } catch (e) {
          console.error(`stopping task '${name}' due to error: ${e}`)
          return
        }
      }
      const _item = item(this.id)
      if (!_item.tasks) _item.tasks = {}
      _item.tasks[name] = task // replaces any previous task under same name
      this.dispatch(task, delay_ms) // initial dispatch
    }

    // cancels any previously dispatched task under given name
    cancel_task(name) {
      const _item = item(this.id)
      if (!_item.tasks) return
      delete _item.tasks[name]
    }

    // promise = new Promise attached (see above) to item
    // the given executor function (resolve[,reject])=>{} is also attached
    promise(func) {
      return this.attach(new Promise(this.attach(func)))
    }

    // resolve = same as Promise.resolve but with the returned promise attached
    resolve(thing) {
      return this.attach(Promise.resolve(thing))
    }

    // console logging functions pre-attached to this item
    debug(...args) {
      this.invoke(() => console.debug(...args))
    }
    info(...args) {
      this.invoke(() => console.info(...args))
    }
    log(...args) {
      this.invoke(() => console.log(...args))
    }
    warn(...args) {
      this.invoke(() => console.warn(...args))
    }
    error(...args) {
      this.invoke(() => console.error(...args))
    }
    fatal(...args) {
      const stack = new Error().stack.split('\n').join(' <- ')
      throw new Error(`${args.join(' ')} @ ${this.name} @ ${stack}`)
    }

    // delay = promise resolved after specified time
    delay(ms) {
      return this.promise(resolve => setTimeout(resolve, ms))
    }

    // return array of uploaded image srcs, urls ({output:"url"}), or blobs ({output:"blob"})
    // returns promise for urls or blobs as they require download and decryption
    images(options = {}) {
      let srcs = _.uniq(
        Array.from(
          (
            this.text
              .replace(/(?:^|\n) *```.*?\n *```/gs, '') // remove multi-line blocks
              // NOTE: currently we miss indented blocks that start with bullets (since it requires context)
              .replace(/(?:^|\n)     *[^-*+ ].*(?:$|\n)/g, '') // remove 4-space indented blocks
              .replace(/(^|[^\\])`.*?`/g, '$1') as any
          ).matchAll(/<img .*?src\s*=\s*"(.*?)".*?>/gi),
          m => m[1]
        ).map(src =>
          src.replace(/^https?:\/\/www\.dropbox\.com/, 'https://dl.dropboxusercontent.com').replace(/\?dl=0$/, '')
        )
      ).filter(src => src.match(/^\d+$/) || src.startsWith(user.uid + '/images/'))
      const output = options['output'] || 'src'
      if (!['src', 'url', 'blob'].includes(output)) {
        console.error(`images: invalid output '${output}', should be src, url, or blob`)
        return srcs
      }
      if (output == 'src') return srcs
      return Promise.all(
        srcs.map(src => {
          if (src.match(/^\d+$/)) src = user.uid + '/images/' + src // prefix {uid}/images/ automatically
          return new Promise((resolve, reject) => {
            if (images.has(src)) {
              // already available locally, convert to blob
              const url = images.get(src)
              if (output == 'url') {
                resolve(url)
                return
              }
              let start = Date.now()
              let xhr = new XMLHttpRequest()
              xhr.responseType = 'blob'
              xhr.onload = event => {
                const blob = xhr.response
                console.debug(`retrieved image ${src} (${blob.type}, ${blob.size} bytes) in ${Date.now() - start}ms`)
                resolve(blob)
              }
              xhr.onerror = console.error
              xhr.open('GET', url)
              xhr.send()
              return
            }
            const ref = firebase().storage().ref().child(src)
            ref
              .getDownloadURL()
              .then(url => {
                let start = Date.now()
                let xhr = new XMLHttpRequest()
                xhr.responseType = 'blob'
                xhr.onload = event => {
                  const blob = xhr.response
                  console.debug(`downloaded image ${src} (${blob.type}, ${blob.size} bytes) in ${Date.now() - start}ms`)
                  if (src.startsWith('anonymous/')) {
                    resolve(output == 'blob' ? blob : URL.createObjectURL(blob))
                    return
                  }
                  start = Date.now()
                  const reader = new FileReader()
                  reader.readAsBinaryString(blob)
                  reader.onload = e => {
                    const cipher = e.target.result as string
                    decrypt(cipher)
                      .then(str => {
                        const type = str.substring(0, str.indexOf(';'))
                        str = str.substring(str.indexOf(';') + 1)
                        console.debug(
                          `decrypted image ${src} (${type}, ${str.length} bytes) in ${Date.now() - start}ms`
                        )
                        const array = new Uint8Array(
                          [].map.call(str, function (x) {
                            return x.charCodeAt(0)
                          })
                        )
                        const blob = new Blob([array], { type: type })
                        resolve(output == 'blob' ? blob : URL.createObjectURL(blob))
                      })
                      .catch(e => {
                        console.error(e)
                        reject(e)
                      })
                  }
                  reader.onerror = console.error
                }
                xhr.onerror = console.error
                xhr.open('GET', url)
                xhr.send()
              })
              .catch(e => {
                console.error(e)
                reject(e)
              })
          })
        })
      )
    }

    // invalidates element cache for item
    // often invoked from error handling code
    // otherwise can force_render to ensure re-render even if deephash/time/html are unchanged
    invalidate_elem_cache(force_render = false) {
      invalidateElemCache(this.id)
      if (force_render) {
        item(this.id).version++
        items = items // trigger svelte render
      }
    }
  }

  function itemTimeString(time: number, round_up = false) {
    const round = round_up ? Math.ceil : Math.floor
    time = (Date.now() - time) / 1000
    if (time < 60) return round_up ? '1m' : 'now'
    if (time < 3600) return round(time / 60).toString() + 'm'
    if (time < 24 * 3600) return round(time / 3600).toString() + 'h'
    return round(time / (24 * 3600)).toString() + 'd'
  }

  function resizeHiddenColumn() {
    // programmatically size hidden column to match first column
    if (document.querySelector('.column.hidden'))
      (document.querySelector('.column.hidden') as HTMLElement).style.width =
        (document.querySelector('.column:not(.hidden)') as HTMLElement).offsetWidth + 'px'
  }

  let padding = 0
  let lastViewHeight = 0
  function updateVerticalPadding() {
    // replace "vh" units with "px" which is better supported on android (and presumably elsewhere also)
    // in particular on android "vh" units can cause jitter or flicker during scrolling tall views
    // as a nice side effect this ensures header stays in view (precisely) on ios
    // we need to use innerHeight since it is also used to calculate scroll positions
    // innerHeight can change frequently, which is ok as long as updateVerticalPadding is invoked carefully
    const viewHeight = innerHeight
    if (itemsdiv && viewHeight != lastViewHeight) {
      const prevScrollTop = document.body.scrollTop
      const prevPadding = itemsdiv.querySelector('.column-padding').offsetHeight
      padding = 0.7 * viewHeight
      // padding += Math.max(0, 20 - (prevScrollTop + padding - prevPadding))
      itemsdiv.querySelectorAll('.column-padding').forEach((div: HTMLElement) => (div.style.height = padding + 'px'))
      // adjust bottom padding and then scroll position to prevent jumping
      itemsdiv.style.paddingBottom = padding + 'px'
      document.body.scrollTo(0, prevScrollTop + padding - prevPadding)
      lastViewHeight = viewHeight
    }
  }

  function getDocumentWidth() {
    // we use document width because it is invariant to zoom scale but sensitive to font size
    // also window.outerWidth can be stale after device rotation in iOS Safari
    // we divide by optional zoom factor to get effective width post-zoom
    return document.documentElement.clientWidth / (parseFloat(zoom) || 1)
  }

  let indexFromId
  let itemsdiv
  let headerdiv
  let consolediv
  let headerScrolled = false
  let dotCount = 0
  let columnCount = 0
  let toggles = []
  let newestTime = 0
  let oldestTime = Infinity
  let oldestTimeString = ''
  let defaultHeaderHeight = 0
  // TODO: try maxColumns=1 during initial render if partial-height layouts prove problematic
  let defaultItemHeight = 0 // if zero, initial layout will be single-column
  let totalItemHeight = 0
  let lastFocusedEditElement = null
  let lastTimeStringUpdateTime = 0
  let showDotted = false

  function updateItemLayout() {
    // console.debug("updateItemLayout");
    editingItems = []
    focusedItem = -1
    indexFromId = new Map<string, number>()
    dotCount = 0

    // set zoom (if any) on items div
    if (itemsdiv && itemsdiv.style.zoom != zoom) itemsdiv.style.zoom = zoom
    const documentWidth = getDocumentWidth()
    const minColumnWidth = 500 // minimum column width for multiple columns
    columnCount = Math.max(1, Math.floor(documentWidth / minColumnWidth))
    let columnHeights = new Array(columnCount).fill(0)
    let columnLastItem = new Array(columnCount).fill(-1)
    let columnItemCount = new Array(columnCount).fill(0)
    columnHeights[0] = headerdiv ? headerdiv.offsetHeight : defaultHeaderHeight // first column includes header
    let topMovers = new Array(columnCount).fill(items.length)
    let lastTimeString = ''
    newestTime = 0
    oldestTime = Infinity
    oldestTimeString = ''
    totalItemHeight = 0
    lastTimeStringUpdateTime = Date.now()
    // showDotted = false; // auto-hide dotted
    resizeHiddenColumn()
    updateVerticalPadding()

    // as soon as header is available, add top margin and scroll down to header
    // also store header offset for all other scrollTo calculations
    if (headerdiv && !headerScrolled) {
      document.body.scrollTo(0, headerdiv.offsetTop)
      headerScrolled = true
    }

    items.forEach((item, index) => {
      item.index = index
      indexFromId.set(item.id, index)
      if (item.dotted) dotCount++
      if (item.editing) editingItems.push(index)
      if (item.dotted && item.editing) showDotted = true
      if (item.focused) focusedItem = index

      let lastItem = items[index - 1]
      let timeString = itemTimeString(item.time)
      if (item.time < oldestTime) {
        oldestTime = item.time
        oldestTimeString = timeString
      }
      if (item.time > newestTime) newestTime = item.time

      item.timeString = ''
      item.timeOutOfOrder = false
      if (!item.pinned && (index == 0 || timeString != lastTimeString)) {
        item.timeString = timeString
        item.timeOutOfOrder = index > 0 && !lastItem.pinned && item.time > lastItem.time && timeString != lastTimeString
        lastTimeString = timeString // for grouping of subsequent items
      }

      // calculate item height (zero if dotted, or not yet calculated and default is zero)
      item.outerHeight = item.dotted ? 0 : item.height || defaultItemHeight
      // add item margins + time string height
      if (item.outerHeight > 0) item.outerHeight += 8 + (item.timeString ? 24 : 0)
      totalItemHeight += item.height // used to hide items until height available

      // determine item column
      item.nextColumn = -1
      item.nextItemInColumn = -1

      if (index == 0) item.column = 0
      else {
        // stay on same column unless column height would exceed minimum column height by 90% of screen height
        const lastColumn = lastItem.column
        const minColumnHeight = Math.min(...columnHeights)
        if (
          columnHeights[lastColumn] <= minColumnHeight + 0.5 * outerHeight ||
          columnHeights[lastColumn] + item.outerHeight + 40 <= minColumnHeight + 0.9 * outerHeight
        )
          item.column = lastColumn
        else item.column = columnHeights.indexOf(minColumnHeight)
        if (item.column != lastColumn) {
          lastItem.nextColumn = item.column
          lastItem.arrows = item.column < lastColumn ? '↖' : ''
          for (let i = 0; i < Math.abs(item.column - lastColumn) - 1; ++i)
            lastItem.arrows += item.column < lastColumn ? '←' : '→'
          lastItem.arrows += item.column < lastColumn ? '' : '↗'
          // NOTE: we include .section-separator height but ignore show which is dynamic (like dotted items)
          columnHeights[lastColumn] += 40 // .section-separator height including margins
        }
      }
      // mark item as aboveTheFold if it is pinned or item is visible on first screen
      // if item heights are not available, then we use item index in column and assume top 5 are above fold
      item.aboveTheFold =
        item.pinned ||
        (totalItemHeight > 0 ? columnHeights[item.column] < outerHeight : columnItemCount[item.column] < 5)
      // // item "prominence" i position in screen heights, always 0 if pinned, 1+ if !aboveTheFold
      // item.prominence = item.pinned
      //   ? 0
      //   : totalItemHeight > 0
      //   ? columnHeights[item.column] / outerHeight
      //   : columnItemCount[item.column] / 5;
      // columnItemCount[item.column]++;

      // mark item as "mover" if it changes index and/or column
      item.mover = item.index != item.lastIndex || item.column != item.lastColumn
      if (item.mover && index < topMovers[item.column]) topMovers[item.column] = index
      item.lastIndex = item.index
      item.lastColumn = item.column

      // if non-dotted item is first in its column or section and missing time string, add it now
      // also mark it as a "leader" for styling its index number
      item.leader = !item.dotted && (columnLastItem[item.column] < 0 || item.column != lastItem.column)
      if (item.leader && !item.timeString) {
        item.timeString = timeString
        lastTimeString = timeString // for grouping of subsequent items
        // add time string height now, assuming we are not ignoring item height
        if (item.outerHeight > 0) item.outerHeight += 24
      }
      columnHeights[item.column] += item.outerHeight
      if (columnLastItem[item.column] >= 0) {
        items[columnLastItem[item.column]].nextItemInColumn = index
        // if item is below section-separator and has timeString, discount -24px negative margin
        if (columnLastItem[item.column] != index - 1 && item.timeString) columnHeights[item.column] -= 24
      }
      columnLastItem[item.column] = index
    })

    // maintain focus and scroll to caret if edit element (textarea) changes (due to new focus or switched column)
    // OR scroll up to top mover (if not narrating, since then we prefer manual scroll)
    let activeEditItem
    if (focusedItem >= 0) {
      const div = document.querySelector('#super-container-' + items[focusedItem].id) as HTMLElement
      if (!div) console.warn('focusedItem missing on page')
      else if (!div.contains(document.activeElement)) console.warn('focusedItem does not contain activeElement')
      else activeEditItem = items[focusedItem].id
    }

    const dispatchTime = Date.now()
    tick()
      .then(update_dom)
      .then(() => {
        const focusedEditElement = activeEditItem ? textArea(indexFromId.get(activeEditItem)) : null
        if (activeEditItem && !focusedEditElement.isSameNode(lastFocusedEditElement)) {
          focusedEditElement.focus()
          if (lastScrollTime < dispatchTime) restoreItemEditor(activeEditItem) // scroll to caret
          lastFocusedEditElement = focusedEditElement // prevent scroll on next layout
        } else if (_.min(topMovers) < items.length && !narrating) {
          const itemTop = _.min(
            topMovers.map(index => {
              if (index == items.length) return Infinity // nothing in this column
              const div = document.querySelector('#super-container-' + items[index].id)
              if (!div) return Infinity // item hidden, have to ignore
              return (div as HTMLElement).offsetTop
            })
          )
          // console.log("scrolling to itemTop", itemTop, document.body.scrollTop, topMovers.toString());
          // scroll up to item if needed, bringing it to ~upper-middle, snapping to header (if above mid-screen)
          if (itemTop - 100 < document.body.scrollTop)
            document.body.scrollTo(0, Math.max(headerdiv.offsetTop, itemTop - innerHeight / 4))
          topMovers = new Array(columnCount).fill(items.length) // reset topMovers after scroll
        }
      })
  }

  let images = new Map<string, string>() // permanent fname to temporary url

  function onPastedImage(url: string, file: File, size_handler = null) {
    console.debug('pasted image', url)
    const start = Date.now()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.readAsBinaryString(file)
      reader.onload = e => {
        let str = e.target.result as string
        if (size_handler) size_handler(str.length)
        const hash = hashCode(str).toString()
        const fname = `${user.uid}/images/${hash}` // short fname is just hash
        if (readonly) images.set(fname, url) // skip upload
        if (images.has(fname)) {
          resolve(hash)
          return
        }
        if (anonymous) {
          // console.debug(`uploading image ${fname} (${str.length} bytes) ...`);
          const ref = firebase().storage().ref().child(`${user.uid}/images/${hash}`)
          ref
            .put(file) // gets mime type from file.type
            .then(snapshot => {
              console.debug(`uploaded image ${fname} (${str.length} bytes) in ${Date.now() - start}ms`)
              images.set(fname, url)
              resolve(hash)
            })
            .catch(e => {
              console.error(e)
              reject(e)
            })
        } else {
          encrypt(file.type + ';' + str)
            .then(cipher => {
              // console.debug(
              //   `uploading encrypted image ${fname} (${cipher.length} bytes, ${str.length} original) ...`
              // );
              const ref = firebase().storage().ref().child(`${user.uid}/images/${hash}`)
              ref
                .putString(cipher)
                .then(snapshot => {
                  console.debug(`uploaded encrypted image ${fname} (${cipher.length} bytes) in ${Date.now() - start}ms`)
                  images.set(fname, url)
                  resolve(hash)
                })
                .catch(e => {
                  console.error(e)
                  reject(e)
                })
            })
            .catch(console.error)
        }
      }
      reader.onerror = e => {
        console.error(e)
        reject(e)
      }
    })
  }

  function onImageRendering(src: string): string {
    if (src.match(/^\d+$/)) src = user.uid + '/images/' + src // prefix {uid}/images/ automatically
    if (!src.startsWith(user.uid + '/images/') && !src.startsWith('anonymous/images/')) return src // external image
    if (src.match(/^\d+$/)) src = user.uid + '/images/' + src // prefix {uid}/images/ automatically
    if (images.has(src)) return images.get(src) // image ready
    return '/loading.gif' // image must be loaded
  }

  function onImageRendered(img: HTMLImageElement) {
    // console.debug("image rendered", img.src);
    if (!img.hasAttribute('_src')) return Promise.resolve() // nothing to do
    let src = img.getAttribute('_src')
    if (src.match(/^\d+$/)) src = user.uid + '/images/' + src // prefix {uid}/images/ automatically
    if (images.has(src)) {
      if (img.src != images.get(src)) img.src = images.get(src)
      img.removeAttribute('_loading')
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      // image must be downloaded and decrypted if user is not anonymous
      const ref = firebase().storage().ref().child(src)
      ref
        .getDownloadURL()
        .then(url => {
          if (src.startsWith('anonymous/')) {
            img.src = url
            img.removeAttribute('_loading')
            resolve(img.src)
          } else {
            // download data
            const start = Date.now()
            // console.debug(`downloading encrypted image ${src} ...`);
            let xhr = new XMLHttpRequest()
            xhr.responseType = 'blob'
            xhr.onload = event => {
              const blob = xhr.response
              const reader = new FileReader()
              reader.readAsBinaryString(blob)
              reader.onload = e => {
                const cipher = e.target.result as string
                decrypt(cipher)
                  .then(str => {
                    const type = str.substring(0, str.indexOf(';'))
                    str = str.substring(str.indexOf(';') + 1)
                    console.debug(
                      `downloaded encrypted image ${src} (${type}, ${str.length} bytes) in ${Date.now() - start}ms`
                    )
                    const array = new Uint8Array(
                      [].map.call(str, function (x) {
                        return x.charCodeAt(0)
                      })
                    )
                    img.src = URL.createObjectURL(new Blob([array], { type: type }))
                    img.removeAttribute('_loading')
                    resolve(img.src)
                  })
                  .catch(e => {
                    console.error(e)
                    reject(e)
                  })
              }
              reader.onerror = console.error
            }
            xhr.onerror = console.error
            xhr.open('GET', url)
            xhr.send()
          }
        })
        .catch(e => {
          console.error(e)
          reject(e)
        })
    })
  }
  if (isClient) window['_onImageRendered'] = onImageRendered

  function onEditorFocused(focused: boolean) {
    // NOTE: this does not capture cmd-tilde switching, and in fact none of the window/document focus events seem to fire in that case (e.g. see http://output.jsbin.com/rinece), and indeed document.activeElement and document.hasFocus() remain unchanged; a workaround is to hit a modifier key such as Shift or Alt post-switch to be detected by editor keydown handlers below
    if (focused) focus() // ensure window focus
  }

  // editor keydown handlers have same logic as in window onKeyDown (see below)
  function onEditorKeyDown(e: KeyboardEvent) {
    if (!e.metaKey) focus()
  }
  function onItemEditorKeyDown(e: KeyboardEvent) {
    if (!e.metaKey) focus()
  }

  function isSpecialTag(tag) {
    return (
      tag == '#log' ||
      tag == '#menu' ||
      tag == '#context' ||
      tag == '#init' ||
      tag == '#welcome' ||
      tag == '#listen' ||
      tag == '#async' ||
      tag == '#debug' ||
      tag == '#autorun' ||
      tag == '#spell' ||
      tag == '#nospell' ||
      !!tag.match(/^#pin(?:\/|$)/) ||
      !!tag.match(/\/pin(?:\/|$)/)
    )
  }

  // returns "alternative tags" for dependency analysis and tag search/highlights
  function altTags(tag) {
    if (tag == '#log') return []
    // ["#features/log"]; // visible tag does not need an alt
    else if (tag == '#menu') return ['#features/_menu']
    else if (tag == '#context') return ['#features/_context']
    else if (tag == '#init') return ['#features/_init']
    else if (tag == '#welcome') return ['#features/_welcome']
    else if (tag == '#listen') return ['#features/_listen']
    else if (tag == '#async') return ['#features/_async']
    else if (tag == '#debug') return ['#features/_debug']
    else if (tag == '#autorun') return ['#features/_autorun']
    else if (tag == '#spell') return ['#features/_spell']
    else if (tag == '#nospell') return ['#features/_nospell']
    else if (tag.match(/(?:\/|#)pin(?:\/|$)/)) return ['#features/_pin']
    else return []
  }

  function tagPrefixes(tag) {
    let pos
    let prefixes = []
    while ((pos = tag.lastIndexOf('/')) >= 0) prefixes.push((tag = tag.slice(0, pos)))
    return prefixes
  }

  // NOTE: Invoke onEditorChange only editor text and/or item content has changed.
  //       Invoke updateItemLayout directly if only item sizes have changed.
  let sessionTime = Date.now()
  const editorDebounceTime = 500
  let lastEditorChangeTime = 0
  let matchingItemCount = 0
  let textLength = 0
  let editorChangePending = false
  let forceNewStateOnEditorChange = false
  let finalizeStateOnEditorChange = false
  let replaceStateOnEditorChange = false
  let ignoreStateOnEditorChange = false
  let hideIndex = 0
  let hideIndexMinimal = 0
  let hideIndexFromRanking = 0
  let hideIndexForSession = 0
  let editorChangesWithTimeKept = new Set()

  function onEditorChange(text: string, keep_times = false) {
    editorText = text // in case invoked without setting editorText
    if (keep_times && text.trim()) editorChangesWithTimeKept.add(text.trim())
    else editorChangesWithTimeKept.clear()

    // editor text is considered "modified" and if there is a change from sessionHistory OR from history.state, which works for BOTH for debounced and non-debounced updates; this is used to enable/disable hiding (hideIndex decrease)
    const editorTextModified = text != sessionHistory[sessionHistoryIndex] || text != history.state.editorText

    // keep history entry 0 updated, reset index on changes
    // NOTE: these include rapid changes, unlike e.g. history.state.editorText, but not debounces (editorText has already changed)
    if (text != sessionHistory[sessionHistoryIndex]) {
      sessionHistoryIndex = 0
      if (sessionHistory.length == 0) sessionHistory = [text]
      else sessionHistory[0] = text
      // update highlighting state used in Item.svelte
      window['_mindboxLastModified'] = Date.now()
      window['_mindboxDebounced'] = true
      window['_highlight_counts'] = {}

      // invoke _on_change on all _listen items
      setTimeout(() => {
        items.forEach(item => {
          if (!item.listen) return
          if (!item.text.includes('_on_change')) return
          try {
            _item(item.id).eval(
              `if (typeof _on_change == 'function') _on_change(\`${editorText.replace(/([`\\$])/g, '\\$1')}\`)`,
              { trigger: 'listen' }
            )
          } catch (e) {} // already logged, just continue
        })
      })
    }

    // if editor is non-empty, has focus, and it is too soon since last change/return, debounce
    // NOTE: non-empty condition is dropped if last call was debounced, otherwise backspace can stall on first char
    text = text.toLowerCase().trim() // trim editor for search/navigation purposes
    if (
      (text.length > 0 || lastEditorChangeTime < Infinity) &&
      document.activeElement == textArea(-1) &&
      Date.now() - lastEditorChangeTime < editorDebounceTime
    ) {
      lastEditorChangeTime = Date.now() // reset timer at each postponed change
      if (!editorChangePending) {
        editorChangePending = true
        setTimeout(() => {
          if (!editorChangePending) return // change handled via debounce-bypass
          editorChangePending = false
          onEditorChange(editorText)
        }, editorDebounceTime)
      }
      return
    }
    editorChangePending = false
    lastEditorChangeTime = Infinity // force minimum wait for next change
    window['_mindboxDebounced'] = false
    const start = Date.now()

    const tags = parseTags(text)
    let terms = _.uniq(
      text
        .split(/\s+/)
        .concat(tags.raw)
        .concat(tags.all) // include visible version of hidden tags
        .concat(_.flattenDeep(tags.all.map(altTags)))
        // .concat(_.flatten(tags.all.map(tagPrefixes)))
        // NOTE: for tags that do not match (or not sufficiently), we allow matching tag as non-tag with many variations, but we still prioritize/highlight tag matches and tag prefix (secondary) matches
        .concat(
          _.flattenDeep(
            tags.all.map(t => {
              if (tagCounts.get(t) > 0) return []
              // if (idsFromLabel.get(t)?.length > 0) return [];
              return [t.substring(1)].concat(tagPrefixes(t.substring(1))).concat(t.split('/'))
            })
          )
        )
    ).filter(t => t)

    // disable search for (untrimmed) editor text starting with '/' (as it also required for command parsing), to provide a way to disable search, and to ensure search results do not interfere with commands that create new items or modify existing items
    if (editorText.startsWith('/')) terms = []

    // expand tag prefixes into termsContext
    let termsContext = _.flatten(tags.all.map(tagPrefixes))

    matchingItemCount = 0
    let targetItemCount = 0
    textLength = 0
    let listing = []
    let context = []
    let listingItemIndex = -1
    let idMatchItemIndices = []

    // determine "listing" item w/ unique label matching first term
    // (in reverse order w/ listing item label last so larger is better and missing=-1)
    if (terms[0] != '#log' && idsFromLabel.get(terms[0])?.length == 1) {
      listingItemIndex = indexFromId.get(idsFromLabel.get(terms[0])[0])
      let item = items[listingItemIndex]
      context = [item.label].concat(item.labelPrefixes) // lower index means lower in ranking
      // expand context to include "context" items that visibly tag the top item in context
      // (also add their label to context terms so they are highlighted as context as well)
      while (true) {
        const lastContextLength = context.length
        items.forEach(ctxitem => {
          if (ctxitem.id == item.id) return
          if (
            ctxitem.context &&
            ctxitem.labelUnique &&
            !context.includes(ctxitem.label) &&
            _.intersection(ctxitem.tagsVisible, context).length > 0
          ) {
            context.push(ctxitem.label)
            // NOTE: "context of context" should be at the end (top), so we do difference + concat
            if (ctxitem.labelPrefixes.length > 0)
              context = _.difference(context, ctxitem.labelPrefixes).concat(ctxitem.labelPrefixes)
          }
        })
        if (context.length == lastContextLength) break
      }
      termsContext = _.uniq(termsContext.concat(context))

      listing = item.tagsVisible
        .filter(t => t != item.label)
        .slice()
        .reverse()
        .concat(item.label)
      // console.debug(listing);
    }

    items.forEach((item, index) => {
      textLength += item.text.length

      // match query terms against visible tags (+prefixes) in item
      item.tagMatches = _.intersection(item.tagsVisibleExpanded, terms).length

      // match query terms against item label
      item.labelMatch = terms.includes(item.label)

      // prefix-match first query term against item header text
      // (only for non-tags or unique labels, e.g. not #todo prefix once applied to multiple items)
      item.prefixMatch =
        item.header.startsWith(terms[0]) &&
        (!terms[0].startsWith('#') || (idsFromLabel.get(terms[0]) || []).length <= 1)

      // find "pinned match" term = hidden tags containing /pin with prefix match on first term
      item.pinnedMatchTerm = item.tagsHidden.find(t => t.startsWith(terms[0]) && t.match(/\/pin(?:\/|$)/)) || ''
      item.pinnedMatch = item.pinnedMatchTerm.length > 0

      // set uniqueLabel for shortening code below
      // NOTE: doing this here is easier than keeping these updated in itemTextChanged
      item.uniqueLabel = item.labelUnique ? item.label : ''
      // item.uniqueLabelPrefixes = item.labelUnique ? item.labelPrefixes : [];

      // match tags against item tagsAlt (expanded using altTags), allowing prefix matches
      item.matchingTerms = terms.filter(t => t[0] == '#' && item.tagsAlt.findIndex(tag => tag.startsWith(t)) >= 0)

      // match all terms (tag or non-tag) anywhere in text
      item.matchingTerms = item.matchingTerms.concat(terms.filter(t => item.lctext.includes(t)))

      // match regex:* terms as regex
      item.matchingTerms = item.matchingTerms.concat(
        terms.filter(t => t.match(/^regex:\S+/) && item.lctext.match(new RegExp(t.substring(6))))
      )
      // match id:* terms against id
      const idMatchTerms = terms.filter(t => t.match(/^id:\w+/) && item.id.toLowerCase() == t.substring(3))
      item.matchingTerms = item.matchingTerms.concat(idMatchTerms)
      if (idMatchTerms.length > 0) idMatchItemIndices.push(index)
      item.matchingTerms = _.uniq(item.matchingTerms) // can have duplicates (e.g. regex:*, id:*, ...)

      // match "secondary terms" ("context terms" against expanded tags, non-tags against item deps/dependents)
      // skip secondary terms (for ranking and highlighting) for listing item
      // because it just feels like a distraction in that particular case
      item.matchingTermsSecondary =
        item.index == listingItemIndex
          ? []
          : _.uniq(
              _.concat(
                termsContext.filter(
                  t =>
                    item.tagsExpanded.includes(t) ||
                    item.depsString.toLowerCase().includes(t) ||
                    item.dependentsString.toLowerCase().includes(t)
                ),
                terms.filter(
                  t => item.depsString.toLowerCase().includes(t) || item.dependentsString.toLowerCase().includes(t)
                )
              )
            )

      // item is considered matching if primary terms match
      // (i.e. secondary terms are used only for ranking and highlighting matching tag prefixes)
      // (this is consistent with .index.matching in Item.svelte)
      item.matching = item.matchingTerms.length > 0
      if (item.matching) matchingItemCount++

      // listing item and id-matching items are considered "target" items
      item.target = listingItemIndex == index || idMatchTerms.length > 0
      item.target_context = !item.target && context.includes(item.uniqueLabel)
      if (item.target) targetItemCount++

      // calculate missing tags (excluding certain special tags from consideration)
      // visible tags are considered "missing" if no other item contains them
      // hidden tags are considered "missing" if not a UNIQUE label (for unambiguous dependencies)
      // hidden "special" tags are not considered "missing" since they toggle special features
      // NOTE: doing this here is easier than keeping these updated in itemTextChanged
      // NOTE: tagCounts include prefix tags, deduplicated at item level
      item.missingTags = item.tagsVisible
        .filter(t => t != item.label && (tagCounts.get(t) || 0) <= 1)
        .concat(item.tagsHidden.filter(t => t != item.label && !isSpecialTag(t) && idsFromLabel.get(t)?.length != 1))

      // if (item.missingTags.length > 0) console.debug(item.missingTags, item.tags);

      // mark 'has error' on error or warnings, OR if item is marked 'pushable'
      item.hasError = item.text.match(/(?:^|\n)(?:ERROR|WARNING):/) != null || item.pushable
    })

    // Update (but not save yet) times for editing and running non-log items to maintain ordering
    // among running/editing items within their sort level (see ordering logic below)
    let now = Date.now()
    items.forEach(item => {
      if ((item.editing || item.running) && !item.log) item.time = now
    })

    if (!keep_times) {
      // Update time for listing item (but not save yet, a.k.a. "soft touch")
      // NOTE: we may add a few ms to the current time to dominate other recent touches (e.g. tag clicks)
      if (listingItemIndex >= 0 && !items[listingItemIndex].log) items[listingItemIndex].time = now + 2 // prioritize

      // Update times for id-matching items (but not save yet, a.k.a. "soft touch")
      idMatchItemIndices.forEach(index => {
        if (!items[index].log) items[index].time = now + 1 // prioritize
      })
    }

    // insert dummy item with time=now to determine (below) index after which items are ranked purely by time
    items.push({
      dotted: false,
      dotTerm: '',
      pinned: false,
      pinTerm: '',
      pinnedMatch: false,
      pinnedMatchTerm: '',
      uniqueLabel: '',
      editing: false,
      tagMatches: 0,
      prefixMatch: false,
      matchingTerms: [],
      matchingTermsSecondary: [],
      missingTags: [],
      hasError: false,
      time: now + 1000 /* dominate any offsets used above */,
      id: null,
    })

    // returns position of minimum non-negative number, or -1 if none found
    function min_pos(xJ) {
      let jmin = -1
      for (let j = 0; j < xJ.length; ++j) if (xJ[j] >= 0 && (jmin < 0 || xJ[j] < xJ[jmin])) jmin = j
      return jmin
    }

    // NOTE: this assignment is what mainly triggers toHTML in Item.svelte
    //       (even assigning a single index, e.g. items[0]=items[0] triggers toHTML on ALL items)
    //       (afterUpdate is also triggered by the various assignments above)
    // NOTE: undefined values produce NaN, which is treated as 0
    // NOTE: bool - bool is fine (even w/o parens), but true - undefined is NaN~0
    items = items.sort(
      (a, b) =>
        // dotted? (contains #_pin/dot or #_pin/dot/*)
        b.dotted - a.dotted ||
        // alphanumeric ordering on #_pin/dot/* term (see https://stackoverflow.com/a/38641281)
        a.dotTerm.localeCompare(b.dotTerm, undefined, {
          numeric: true,
          sensitivity: 'base',
        }) ||
        // pinned? (contains #_pin or #_pin/*)
        b.pinned - a.pinned ||
        // alphanumeric ordering on #_pin/* term
        a.pinTerm.localeCompare(b.pinTerm, undefined, {
          numeric: true,
          sensitivity: 'base',
        }) ||
        // pinned match? (contains /pin or /pin/*)
        b.pinnedMatch - a.pinnedMatch ||
        // alphanumeric ordering on #*/pin/* term
        a.pinnedMatchTerm.localeCompare(b.pinnedMatchTerm, undefined, {
          numeric: true,
          sensitivity: 'base',
        }) ||
        // log items matching #log query ordered by time
        (text == '#log' && b.log ? b.time : 0) - (text == '#log' && a.log ? a.time : 0) ||
        // listing item context position (includes labelPrefixes)
        context.indexOf(b.uniqueLabel) - context.indexOf(a.uniqueLabel) ||
        // position of (unique) label in listing item (item w/ unique label = first term)
        // (listing is reversed so larger index is better and missing=-1)
        listing.indexOf(b.uniqueLabel) - listing.indexOf(a.uniqueLabel) ||
        // editing mode (except log items)
        (!b.log && b.editing) - (!a.log && a.editing) ||
        // # of matching (visible) tags from query
        b.tagMatches - a.tagMatches ||
        // label match (OR tag matches to prevent non-unique labels dominating tags)
        Math.max(b.labelMatch, b.tagMatches.length) - Math.max(a.labelMatch, a.tagMatches.length) ||
        // // // position of longest matching label prefix in listing item
        // // min_pos(listing.map((pfx) => b.uniqueLabelPrefixes.indexOf(pfx))) -
        // //   min_pos(listing.map((pfx) => a.uniqueLabelPrefixes.indexOf(pfx))) ||
        // prefix match on first term
        b.prefixMatch - a.prefixMatch ||
        // # of matching words/tags from query
        b.matchingTerms.length - a.matchingTerms.length ||
        // # of matching secondary words from query
        b.matchingTermsSecondary.length - a.matchingTermsSecondary.length ||
        // missing tag prefixes
        b.missingTags.length - a.missingTags.length ||
        // errors
        b.hasError - a.hasError ||
        // time (most recent first)
        b.time - a.time
    )

    // determine "tail" index after which items are ordered purely by time
    // (also including editing items, including log items which are edited in place)
    // (also including hasError items which need to be prominent)
    let tailIndex = items.findIndex(item => item.id === null)
    items.splice(tailIndex, 1)
    tailIndex = Math.max(tailIndex, _.findLastIndex(items, item => item.editing) + 1)
    tailIndex = Math.max(tailIndex, _.findLastIndex(items, item => item.hasError) + 1)
    let tailTime = items[tailIndex]?.time || 0
    hideIndexFromRanking = tailIndex
    const prevHideIndex = hideIndex // to possibly take max later (see below)
    hideIndex = hideIndexFromRanking

    // update layout (used below, e.g. aboveTheFold, editingItems, etc)
    updateItemLayout()
    lastEditorChangeTime = Infinity // force minimum wait for next change

    // determine "toggle" indices (ranges) where item visibility can be toggled
    toggles = []

    // when hideIndexFromRanking is large, we use position-based toggle points to reduce unnecessary computation
    let unpinnedIndex = _.findLastIndex(items, item => item.pinned || item.editing || item.target) + 1
    let belowFoldIndex = _.findLastIndex(items, item => item.aboveTheFold || item.editing || item.target) + 1
    if (unpinnedIndex < Math.min(belowFoldIndex, hideIndexFromRanking)) {
      toggles.push({
        start: unpinnedIndex,
        end: Math.min(belowFoldIndex, hideIndexFromRanking),
        positionBased: true,
      })
    }
    if (belowFoldIndex < hideIndexFromRanking) {
      let lastToggleIndex = belowFoldIndex
      ;[10, 30, 50, 100, 200, 500, 1000].forEach(toggleIndex => {
        if (lastToggleIndex >= hideIndexFromRanking) return
        toggles.push({
          start: lastToggleIndex,
          end: Math.min(belowFoldIndex + toggleIndex, hideIndexFromRanking),
          positionBased: true,
        })
        lastToggleIndex = belowFoldIndex + toggleIndex
      })
    }

    // ensure contiguity of position-based toggles up to hideIndexFromRanking
    if (toggles.length > 0) toggles[toggles.length - 1].end = hideIndexFromRanking

    // merge position-based toggles smaller than 10 indices
    for (let i = 1; i < toggles.length; i++) {
      if (toggles[i - 1].end - toggles[i - 1].start < 10 || toggles[i].end - toggles[i].start < 10) {
        toggles[i - 1].end = toggles[i].end
        toggles.splice(i--, 1) // merged into last
      }
    }

    // calculate "minimal" hide index used when window is defocused or items edited
    // minimal index is either the first time-ranked item, or the first position-based hidden item
    hideIndexMinimal =
      toggles.length == 0 ? hideIndexFromRanking : targetItemCount > 0 ? toggles[0].start : toggles[0].end

    // first time-based toggle point is the "session toggle" for items "touched" in this session (since first ranking)
    // NOTE: there is a difference between soft and hard touched items: soft touched items can be hidden again by going back (arguably makes sense since they were created by soft interactions such as navigation and will go away on reload), but hard touched items can not, so they are "sticky" in that sense.
    hideIndexForSession = Math.max(hideIndexFromRanking, _.findLastIndex(items, item => item.time > sessionTime) + 1)
    // auto-show session items if no position-based toggles, otherwise use minimal
    hideIndex = toggles.length == 0 ? hideIndexForSession : hideIndexMinimal
    // hideIndex = hideIndexMinimal;
    // if editor text is not modified, we can not show less items
    if (!editorTextModified) hideIndex = Math.max(hideIndex, prevHideIndex)
    // if editor text is modified empty, we can not show more items (above hideIndexMinimal)
    // if (editorTextModified && !editorText) hideIndex = Math.min(hideIndex, Math.max(prevHideIndex, hideIndexMinimal))
    // if ranking while unfocused, retreat to minimal index
    // if (!focused) hideIndex = hideIndexMinimal;

    if (hideIndexForSession > hideIndexFromRanking && hideIndexForSession < items.length) {
      toggles.push({
        start: hideIndexFromRanking,
        end: hideIndexForSession,
      })
      tailIndex = hideIndexForSession
      tailTime = items[hideIndexForSession].time
    }

    // add toggle points for "extended tail times"
    // NOTE: we do this by time to help avoid big gaps in time (that cross these thresholds)
    ;[1, 3, 7, 14, 30].forEach(daysAgo => {
      const extendedTailTime = Date.now() - daysAgo * 24 * 3600 * 1000
      if (extendedTailTime > tailTime) return
      const extendedTailIndex = tailIndex + items.slice(tailIndex).filter(item => item.time >= extendedTailTime).length
      if (extendedTailIndex <= tailIndex || extendedTailIndex >= items.length) return
      toggles.push({
        start: tailIndex,
        end: extendedTailIndex,
      })
      tailIndex = extendedTailIndex
      tailTime = items[extendedTailIndex].time
    })
    // add final toggle point for all items
    if (tailIndex < items.length) {
      toggles.push({
        start: tailIndex,
        end: items.length,
      })
    }
    // console.debug(toggles);

    if (!ignoreStateOnEditorChange) {
      // update history, replace unless current state is final (from tag click)
      const orderHash = hashCode(items.map(item => item.id).join())
      if (editorText != history.state.editorText || orderHash != history.state.orderHash) {
        // need to update history
        const state = {
          editorText,
          unsavedTimes: items.filter(item => item.time != item.savedTime).map(item => _.pick(item, ['id', 'time'])),
          orderHash,
          hideIndex,
          scrollPosition: document.body.scrollTop,
          final: finalizeStateOnEditorChange,
        }
        // console.debug(history.state.final ? "push" : "replace", state);
        if (forceNewStateOnEditorChange || (history.state.final && !replaceStateOnEditorChange))
          history.pushState(state, editorText)
        else history.replaceState(state, editorText)
      }
    }
    forceNewStateOnEditorChange = false // processed above
    finalizeStateOnEditorChange = false // processed above
    replaceStateOnEditorChange = false // processed above
    ignoreStateOnEditorChange = false // processed above

    // invoke _on_search on all _listen items
    setTimeout(() => {
      items.forEach(item => {
        if (!item.listen) return
        if (!item.text.includes('_on_search')) return
        try {
          _item(item.id).eval(
            `if (typeof _on_search == 'function') _on_search(\`${editorText.replace(/([`\\$])/g, '\\$1')}\`)`,
            { trigger: 'listen' }
          )
        } catch (e) {} // already logged, just continue
      })
    })

    if (Date.now() - start >= 250) console.warn('onEditorChange took', Date.now() - start, 'ms')
  }

  function toggleItems(index: number) {
    hideIndex = index
    history.replaceState(Object.assign(history.state, { hideIndex }), editorText)
  }

  function onTagClick(id: string, tag: string, reltag: string, e: MouseEvent) {
    focus() // ensure window focus on tag click (mousedown)
    const index = indexFromId.get(id)
    if (index === undefined) return // deleted
    // "soft touch" item if not already newest and not pinned and not log
    // skip time change if alt is held
    if (!e.altKey) {
      if (items[index].time > newestTime) console.warn('invalid item time')
      else if (items[index].time < newestTime && !items[index].pinned && !items[index].log)
        items[index].time = Date.now()
      // console.debug(e.pageX, e.pageY, document.documentElement.scrollLeft, document.documentElement.scrollTop);
    }

    // NOTE: Rendered form of tag should be renderTag(reltag). We use common suffix to map click position.
    const rendered = renderTag(reltag)
    let suffix = rendered
    while (!tag.endsWith(suffix)) suffix = suffix.substring(1)
    let prefix_click = false
    if (suffix) {
      // calculate partial tag prefix (e.g. #tech for #tech/math) based on position of click
      let range = document.caretRangeFromPoint(
        e.pageX - document.documentElement.scrollLeft,
        e.pageY - document.documentElement.scrollTop
      )
      if (range) {
        let tagNode = e.target as Node
        // if target is not the tag node, it must be a highlight, so we move to the parent
        if ((tagNode as HTMLElement).tagName != 'MARK') tagNode = tagNode.parentNode
        // console.debug("tag click: ", range.startOffset, clickNode, tagNode.childNodes);
        // if tag node contains highlight, we have to adjust click position
        let pos = range.startOffset
        for (const child of Array.from(tagNode.childNodes)) {
          if (child.contains(range.startContainer)) break
          pos += child.textContent.length
        }
        // adjust pos from rendered to full tag ...
        pos = Math.max(pos, rendered.length - suffix.length)
        pos = tag.length - suffix.length + (pos - (rendered.length - suffix.length))
        prefix_click = pos > 1 && pos <= tag.length - suffix.length
        // we only take partial tag if the current tag is "selected" (i.e. full exact match)
        // (makes it easier to click on tags without accidentally getting a partial tag)
        // if ((tagNode as HTMLElement).classList.contains("selected"))
        tag = tag.substring(0, pos) + tag.substring(pos).match(/^[^\/]*/)[0]
      } else {
        console.warn('got null range for tag click: ', tag, e)
      }
    } else {
      // NOTE: this can happen for link tags where rendered text is arbitrary, and without a common suffix we just take the full tag
      // console.warn("could not find matching suffix", tag, rendered);
    }
    tag = tag.replace(/^#_/, '#') // ignore hidden tag prefix

    if (editorText.trim().toLowerCase() == tag.toLowerCase()) {
      if (prefix_click) {
        // assuming trying to go to a parent/ancestor
        alert(`${tag} already selected`)
        return
      } else editorText = '' // assume intentional toggle
    } else {
      editorText = tag + ' ' // space in case more text is added
    }
    forceNewStateOnEditorChange = true // force new state
    finalizeStateOnEditorChange = true // finalize state
    tick().then(() => editor.setSelection(editorText.length, editorText.length))
    lastEditorChangeTime = 0 // disable debounce even if editor focused
    onEditorChange(editorText, e.altKey /* keep_times */)

    if (narrating) return
    // scroll up (or down) to target item if needed
    if (items.findIndex(item => item.target) >= 0) {
      tick()
        .then(update_dom)
        .then(() => {
          let topTargets = new Array(columnCount).fill(items.length)
          items.forEach((item, index) => {
            if (item.target && index < topTargets[item.column]) topTargets[item.column] = index
          })
          const itemTop = _.min(
            topTargets.map(index => {
              if (index == items.length) return Infinity // nothing in this column
              const div = document.querySelector('#super-container-' + items[index].id)
              if (!div) return Infinity // item hidden, have to ignore
              return (div as HTMLElement).offsetTop
            })
          )
          if (itemTop == Infinity) return // nothing to scroll to
          // if item is too far up or down, bring it to ~upper-middle, snapping up to header
          if (itemTop - 100 < document.body.scrollTop || itemTop > document.body.scrollTop + innerHeight - 200)
            document.body.scrollTo(0, Math.max(headerdiv.offsetTop, itemTop - innerHeight / 4))
        })
    }
  }

  function onLinkClick(id: string, href: string, e: MouseEvent) {
    const index = indexFromId.get(id)
    if (index === undefined) return // deleted
    // "soft touch" item if not already newest and not pinned and not log
    if (items[index].time > newestTime) console.warn('invalid item time')
    else if (items[index].time < newestTime && !items[index].pinned && !items[index].log) {
      items[index].time = Date.now()
      onEditorChange(editorText) // item time has changed
    }
  }

  function onLogSummaryClick(id: string) {
    let index = indexFromId.get(id)
    if (index === undefined) return
    items[index].showLogs = !items[index].showLogs
    items[index].showLogsTime = Date.now() // invalidates auto-hide
  }

  function onPopState(e) {
    readonly = anonymous && !admin
    if (!e?.state) return // for fragment (#id) hrefs
    if (!initialized) {
      // NOTE: this can happen when tab is restored, seems harmless so far
      // console.warn("onPopState before init");
      return
    }
    // console.debug("onPopState", e.state, items.length + " items");

    // restore editor text and unsaved times
    editorText = e.state.editorText || ''
    if (e.state.unsavedTimes) {
      items.forEach(item => (item.time = item.savedTime))
      e.state.unsavedTimes.forEach(entry => {
        const index = indexFromId.get(entry.id)
        if (index === undefined) return // item was deleted
        items[index].time = entry.time
      })
    }
    lastEditorChangeTime = 0 // disable debounce even if editor focused
    ignoreStateOnEditorChange = true // do not update history when going back
    onEditorChange(editorText, true /* keep_times */)
    // restore (lower) hide index _after_ onEditorChange which sets it to default index given query
    if (typeof e.state.hideIndex == 'number') hideIndex = Math.max(hideIndex, e.state.hideIndex)
    // if (narrating) return;
    // scroll to last recorded scroll position at this state
    tick()
      .then(update_dom)
      .then(() => document.body.scrollTo(0, e.state.scrollPosition || 0))
  }

  function resetUser() {
    user = null
    // NOTE: we do not modify secret since resetUser() is used for initialization in onAuthStateChanged
    localStorage.removeItem('mindpage_user')
    window.sessionStorage.removeItem('mindpage_signin_pending')
    document.cookie = '__session=;max-age=0' // delete cookie for server
  }

  let signingOut = false
  function signOut() {
    if (window.sessionStorage.getItem('mindpage_signin_pending')) console.warn('signing out while signin pending ...')
    signingOut = true

    // blur active element as caret can show through loading div
    // (can require dispatch on chrome if triggered from active element)
    setTimeout(() => (document.activeElement as HTMLElement).blur())

    localStorage.removeItem('mindpage_secret') // also remove secret when signing out
    resetUser()
    firebase()
      .auth()
      .signOut()
      .then(() => {
        console.log('signed out')
        location.reload()
      })
      .catch(console.error)
  }

  let idsFromLabel = new Map<string, string[]>()
  function itemDeps(index, deps = []) {
    let item = items[index]
    if (deps.includes(item.id)) return deps
    // NOTE: dependency order matters for hashing and potentially for code import
    deps = [item.id].concat(deps) // prepend temporarily to avoid cycles, moved to back below
    const root = deps.length == 1
    item.tagsHiddenAlt.forEach(tag => {
      // NOTE: we allow special tags as dependents if corresponding uniquely named items exist
      // if (isSpecialTag(tag)) return;
      if (!idsFromLabel.has(tag)) return
      const ids = idsFromLabel.get(tag)
      if (ids.length > 1) return // only unique labels can have dependents
      ids.forEach(id => {
        const dep = indexFromId.get(id)
        if (dep == undefined) return // deleted
        deps = itemDeps(dep, deps)
      })
    })
    return root ? deps.slice(1) : deps.slice(1).concat(item.id)
  }

  function itemDepsString(item) {
    return item.deps
      .map(id => {
        const dep = items[indexFromId.get(id)]
        return dep.name + (dep.deepasync ? '(async)' : '')
      })
      .join(' ')
  }

  function itemDependentsString(item) {
    return item.dependents
      .map(id => {
        const dep = items[indexFromId.get(id)]
        const visible = item.labelUnique && dep.tagsVisible.includes(item.label)
        return dep.name + (visible ? '(visible)' : '')
      })
      .join(' ')
  }

  function resolveTags(label, tags) {
    return tags
      .map(tag => {
        if (tag == label) return tag
        else if (tag.startsWith('#//')) return label.replace(/\/[^\/]*$/, '') + tag.substring(2)
        else if (tag.startsWith('#/')) return label + tag.substring(1)
        else return tag
      })
      .filter(t => !t.startsWith('#/')) // "resolved" tags can not start with #/ by convention
  }

  let tagCounts = new Map<string, number>()
  function itemTextChanged(
    index: number,
    text: string,
    update_deps = true,
    run_deps = true,
    keep_time = false,
    remote = false
  ) {
    // console.debug("itemTextChanged", index);
    let item = items[index]
    item.hash = hashCode(text)
    item.lctext = text.toLowerCase()
    item.runnable = item.lctext.match(/\s*```\w+_input(?:_hidden|_removed)?(?:\s|$)/)
    item.scripted = item.lctext.match(/<script.*?>/)
    item.macroed = item.lctext.match(/<<.*?>>/) || item.lctext.match(/@\{.*?\}@/)

    const tags = parseTags(item.lctext)
    item.tags = tags.all
    item.tagsVisible = tags.visible
    item.tagsHidden = tags.hidden
    item.tagsRaw = tags.raw
    item.tagsAlt = _.uniq(_.flattenDeep(item.tags.concat(item.tags.map(altTags))))
    item.tagsHiddenAlt = _.uniq(_.flattenDeep(item.tagsHidden.concat(item.tagsHidden.map(altTags))))
    item.log = item.tagsRaw.includes('#_log') // can also be visible label #log, see below
    item.context = item.tagsRaw.includes('#_context')
    const prev_init = item.init // for possible warning below
    item.init = item.tagsRaw.includes('#_init')
    const prev_welcome = item.welcome // for possible warning below
    item.welcome = item.tagsRaw.includes('#_welcome')
    item.listen = item.tagsRaw.includes('#_listen')
    item.async = item.tagsRaw.includes('#_async')
    item.debug = item.tagsRaw.includes('#_debug')
    item.autorun = item.tagsRaw.includes('#_autorun')
    const pintags = item.tagsRaw.filter(t => t.match(/^#_pin(?:\/|$)/))
    item.pinned = pintags.length > 0
    item.pinTerm = pintags[0] || ''
    item.dotted = pintags.findIndex(t => t.match(/^#_pin\/dot(?:\/|$)/)) >= 0
    item.dotTerm = pintags.filter(t => t.match(/^#_pin\/dot(?:\/|$)/))[0] || ''

    // if item stats with visible #tag, it is taken as a "label" for the item
    // (we allow some html tags/macros to precede the label tag for styling purposes)
    const prevLabel = item.label
    item.header = item.lctext.replace(/^<.*>\s+#/, '#').match(/^.*?(?:\n|$)/)[0]
    item.label = item.header.startsWith(item.tagsVisible[0]) ? item.tagsVisible[0] : ''
    item.labelText = item.label ? item.text.replace(/^<.*>\s+#/, '#').match(/^#\S+/)[0] : ''
    if (item.labelUnique == undefined) item.labelUnique = false
    if (item.labelPrefixes == undefined) item.labelPrefixes = []
    if (item.label) {
      // resolve tags relative to label
      item.tags = resolveTags(item.label, item.tags)
      item.tagsVisible = resolveTags(item.label, item.tagsVisible)
      item.tagsHidden = resolveTags(item.label, item.tagsHidden)
      item.tagsRaw = resolveTags(item.label, item.tagsRaw)
      item.tagsAlt = resolveTags(item.label, item.tagsAlt)
      item.tagsHiddenAlt = resolveTags(item.label, item.tagsHiddenAlt)
    }
    if (item.label != prevLabel) {
      item.labelUnique = false
      if (prevLabel) {
        const ids = idsFromLabel.get(prevLabel).filter(id => id != item.id)
        idsFromLabel.set(prevLabel, ids)
        if (ids.length == 1) {
          let other = items[indexFromId.get(ids[0])]
          other.labelUnique = true
          other.name = other.labelUnique ? other.labelText : 'id:' + other.id
        } else if (ids.length == 0) {
          // delete to ensure all keys are used
          idsFromLabel.delete(prevLabel)
        }
      }
      if (item.label) {
        const ids = (idsFromLabel.get(item.label) || []).concat(item.id)
        idsFromLabel.set(item.label, ids)
        item.labelUnique = ids.length == 1
        if (ids.length == 2) {
          let other = items[indexFromId.get(ids[0])]
          other.labelUnique = false
          other.name = other.labelUnique ? other.labelText : 'id:' + other.id
        }
      }
      item.labelPrefixes = []
      let label = item.label
      let pos
      while ((pos = label.lastIndexOf('/')) >= 0) item.labelPrefixes.push((label = label.slice(0, pos)))
    }

    // #log label designates log items and is never considered unique
    if (item.label == '#log') {
      item.log = true
      item.labelUnique = false
    }

    // name is always unique and either unique label or id:<id>
    item.name = item.labelUnique ? item.labelText : 'id:' + item.id

    // compute expanded tags including prefixes
    const prevTagsExpanded = item.tagsExpanded || []
    item.tagsExpanded = item.tags.slice()
    item.tags.forEach(tag => {
      item.tagsExpanded = item.tagsExpanded.concat(tagPrefixes(tag))
    })
    item.tagsExpanded = _.uniq(item.tagsExpanded)
    if (!_.isEqual(item.tagsExpanded, prevTagsExpanded)) {
      prevTagsExpanded.forEach(tag => tagCounts.set(tag, tagCounts.get(tag) - 1))
      item.tagsExpanded.forEach(tag => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1))
    }
    item.tagsVisibleExpanded = item.tagsVisible
    item.tagsVisible.forEach(tag => {
      item.tagsVisibleExpanded = item.tagsVisibleExpanded.concat(tagPrefixes(tag))
    })

    if (update_deps) {
      const prevDeps = item.deps || []
      const prevDependents = item.dependents || []
      item.deps = itemDeps(index)
      // console.debug("updated dependencies:", item.deps);

      const prevDeepHash = item.deephash
      item.deephash = hashCode(
        item.deps
          .map(id => items[indexFromId.get(id)].hash)
          .concat(item.hash)
          .join(',')
      )
      if (item.deephash != prevDeepHash && !item.log && !keep_time) item.time = Date.now()
      item.deepasync = item.async || item.deps.some(id => items[indexFromId.get(id)].async)

      // warn about new _init or _welcome items
      // doing this under update_deps ensures item is new or modified (vs initialized)
      if (item.init && !prev_init) console.warn(`new init item ${item.name} may require reload`)
      else if (item.welcome && !prev_welcome) console.warn(`new welcome item ${item.name} may require reload`)
      const new_init_welcome_item_id = (item.init && !prev_init) || (item.welcome && !prev_welcome) ? item.id : null

      // if deephash has changed, invoke _on_item_change on all _listen items
      // also warn about modified (based on deephash) _init or _welcome items
      function invoke_listeners_for_changed_item(id, label, prev_label, dependency = false) {
        const item = items[indexFromId.get(id)]
        if ((item.init || item.welcome) && id != new_init_welcome_item_id && !dependency)
          console.warn(
            `${dependency ? 'dependency-' : ''}modified ${item.init ? 'init' : 'welcome'} ` +
              `item ${item.name} may require reload`
          )
        setTimeout(() => {
          const deleted = !indexFromId.has(id)
          items.forEach(item => {
            if (!item.listen) return
            if (!item.text.includes('_on_item_change')) return
            try {
              _item(item.id).eval(
                `if (typeof _on_item_change == 'function') _on_item_change('${id}','${label}','${prev_label}',${deleted},${remote},${dependency})`,
                {
                  trigger: 'listen',
                }
              )
            } catch (e) {} // already logged, just continue
          })
        })
      }
      if (item.deephash != prevDeepHash) invoke_listeners_for_changed_item(item.id, item.label, prevLabel ?? '')

      // update deps and deephash as needed for all dependent items
      // NOTE: we reconstruct dependents from scratch as needed for new items; we could scan only the dependents array once it exists and label has not changed, but we keep it simple and always do a full scan for now
      if (!item.dependents || item.label != prevLabel || item.deephash != prevDeepHash) {
        item.dependents = []
        items.forEach((depitem, depindex) => {
          if (depindex == index) return // skip self
          const was_dependent = depitem.deps.includes(item.id) // was dependent w/ prevLabel?
          let is_dependent = was_dependent
          if (item.label != prevLabel) {
            // label changed, need to update dependencies
            depitem.deps = itemDeps(depindex)
            is_dependent = depitem.deps.includes(item.id)
          }
          // dependency is considered modified when dependency is added/removed
          if ((is_dependent && item.deephash != prevDeepHash) || is_dependent != was_dependent) {
            // update deps & deephash (triggers re-rendering and cache invalidation)
            depitem.deps = itemDeps(depindex)
            const depitem_prevDeepHash = depitem.deephash
            depitem.deephash = hashCode(
              depitem.deps
                .map(id => items[indexFromId.get(id)].hash)
                .concat(depitem.hash)
                .join(',')
            )
            if (depitem.deephash != depitem_prevDeepHash)
              invoke_listeners_for_changed_item(depitem.id, depitem.label, depitem.label, true /*dependency*/)
            depitem.deepasync = depitem.async || depitem.deps.some(id => items[indexFromId.get(id)].async)
            // if run_deps is enabled and item has _autorun, also dispatch run (w/ sanity check for non-deletion)
            // NOTE: run_deps is slow/expensive and e.g. should be false when synchronizing remote changes
            if (run_deps && depitem.autorun)
              setTimeout(() => {
                if (depitem.index == indexFromId.get(depitem.id)) onItemRun(depitem.index, false /* touch_first */)
              })
          }
          if (depitem.deps.includes(item.id)) item.dependents.push(depitem.id)
        })
        // console.debug("updated dependents:", item.dependents);
      }

      // update deps/dependents strings
      item.depsString = itemDepsString(item)
      item.dependentsString = itemDependentsString(item)
      _.uniq(item.deps.concat(prevDeps)).forEach(id => {
        const dep = items[indexFromId.get(id)]
        if (item.deps.includes(dep.id) && !dep.dependents.includes(item.id)) dep.dependents.push(item.id)
        else if (!item.deps.includes(dep.id) && dep.dependents.includes(item.id))
          dep.dependents = dep.dependents.filter(id => id != item.id)
        dep.dependentsString = itemDependentsString(dep)
        // console.debug("updated dependentsString:", dep.dependentsString);
      })
      _.uniq(item.dependents.concat(prevDependents)).forEach(id => {
        const dep = items[indexFromId.get(id)]
        dep.depsString = itemDepsString(dep)
      })
    }
  }

  // NOTE: secret phrase is initialized OR retrieved only ONCE PER SESSION so that it can not be tampered with after having been used to decrypt existing items; otherwise account can contain items encrypted using different secret phrases, which would make the account unusable
  let secret // retrieved once and stored separately to prevent tampering during session

  import { tick } from 'svelte'
  async function getSecretPhrase(new_phrase: boolean = false) {
    if (anonymous) throw Error('anonymous user can not have a secret phrase')
    if (secret) return secret // already initialized from localStorage
    secret = localStorage.getItem('mindpage_secret')
    if (secret) return secret // retrieved from localStorage
    await tick() // wait until modal is rendered on page

    let phrase = ''
    let confirmed = ''
    if (new_phrase) {
      while (phrase == '' || confirmed != phrase) {
        while (phrase == '') {
          phrase = await modal.show({
            content:
              'Choose a <b>secret phrase</b> to encrypt your items so that they are readable <b>only by you, on your devices</b>. This phrase is never sent or stored anywhere (unless you save it somewhere such as a password manager) and should never be shared with anyone.',
            confirm: 'Continue',
            cancel: 'Sign Out',
            input: '',
            password: true,
            username: user.email,
            autocomplete: 'new-password',
          })
        }
        if (phrase == null) break
        confirmed = await modal.show({
          content: 'Confirm your new secret phrase:',
          confirm: 'Confirm',
          cancel: 'Sign Out',
          input: '',
          password: true,
          username: user.email,
          autocomplete: 'new-password',
        })
        if (confirmed == null) break
        if (confirmed != phrase) {
          await modal.show({
            content: "Confirmed phrase did not match. Let's try again ...",
            confirm: 'Try Again',
            background: 'confirm',
          })
          phrase = ''
        }
      }
    } else {
      phrase = await modal.show({
        content: 'Enter your secret phrase:',
        confirm: 'Continue',
        cancel: 'Sign Out',
        input: '',
        password: true,
        username: user.email,
        autocomplete: 'current-password',
      })
    }
    if (phrase == null || confirmed == null) throw new Error('secret phrase cancelled')
    const secret_utf8 = new TextEncoder().encode(user.uid + phrase)
    const secret_buffer = await crypto.subtle.digest('SHA-256', secret_utf8)
    const secret_array = Array.from(new Uint8Array(secret_buffer))
    const secret_string = secret_array.map(b => String.fromCharCode(b)).join('')
    secret = btoa(secret_string)
    localStorage.setItem('mindpage_secret', secret)
    return secret
  }

  // based on https://gist.github.com/chrisveness/43bcda93af9f646d083fad678071b90a
  async function encrypt(text: string) {
    if (!secret) secret = getSecretPhrase(true /* new_phrase */)
    secret = await Promise.resolve(secret) // resolve secret if promise pending
    const secret_utf8 = new TextEncoder().encode(secret) // utf8-encode secret
    const secret_sha256 = await crypto.subtle.digest('SHA-256', secret_utf8) // sha256-hash the secret
    const iv = crypto.getRandomValues(new Uint8Array(12)) // get 96-bit random iv
    const alg = { name: 'AES-GCM', iv: iv } // configure AES-GCM
    const key = await crypto.subtle.importKey('raw', secret_sha256, alg, false, ['encrypt']) // generate key
    const text_utf8 = new TextEncoder().encode(text) // utf8-encode text
    const cipher_buffer = await crypto.subtle.encrypt(alg, key, text_utf8) // encrypt text using key
    const cipher_array = Array.from(new Uint8Array(cipher_buffer)) // convert cipher to byte array
    const cipher_string = cipher_array.map(byte => String.fromCharCode(byte)).join('') // convert cipher to string
    const cipher_base64 = btoa(cipher_string) // base64-encode cipher
    const iv_hex = Array.from(iv)
      .map(b => ('00' + b.toString(16)).slice(-2))
      .join('') // convert iv to hex string
    return iv_hex + cipher_base64 // return iv + cipher
  }

  async function decrypt(cipher: string) {
    if (!secret) secret = getSecretPhrase()
    secret = await Promise.resolve(secret) // resolve secret if promise pending
    const secret_utf8 = new TextEncoder().encode(secret) // utf8-encode secret
    const secret_sha256 = await crypto.subtle.digest('SHA-256', secret_utf8) // sha256-hash the secret
    const iv = cipher
      .slice(0, 24)
      .match(/.{2}/g)
      .map(byte => parseInt(byte, 16)) // get iv from cipher
    const alg = { name: 'AES-GCM', iv: new Uint8Array(iv) } // configure AES-GCM
    const key = await crypto.subtle.importKey('raw', secret_sha256, alg, false, ['decrypt']) // generate key
    const cipher_string = atob(cipher.slice(24)) // base64-decode cipher
    const cipher_array = new Uint8Array(cipher_string.match(/[\s\S]/g).map(ch => ch.charCodeAt(0))) // convert cipher to byte array
    const text_buffer = await crypto.subtle.decrypt(alg, key, cipher_array) // decrypt cipher using key
    const text = new TextDecoder().decode(text_buffer) // utf8-decode text
    return text
  }
  async function encryptItem(item) {
    if (anonymous) return item // do not encrypt for anonymous user
    if (item.cipher) return item // already encrypted
    if (!item.text) return item // nothing to encrypt
    item.cipher = await encrypt(JSON.stringify(item))
    // setting item.text = null ensures !item.text and that field is cleared in update on firestore
    // full removal in update (but not add/set) requires setting item.text = window["firebase"].firestore.FieldValue.delete()
    item.text = null // null until decryption
    item.attr = null // null until decryption
    return item
  }
  async function decryptItem(item) {
    if (item.text) return item // already decrypted
    if (!item.cipher) return item // nothing to decrypt
    const decrypted = JSON.parse(await decrypt(item.cipher))
    item.text = decrypted.text
    item.attr = decrypted.attr
    item.cipher = null // null until encryption
    return item
  }

  function handleCommandReturn(cmd, item, obj, handleError) {
    if (typeof obj == 'string') {
      lastEditorChangeTime = 0 // disable debounce even if editor focused
      onEditorChange(obj)
      setTimeout(() => textArea(-1).focus()) // refocus (may require dispatch)
    } else if (!obj) {
      // NOTE: we take any falsy return as default behavior, but docs only specify returning nothing/unknown, allowing us to reserve other falsy values for future internal use (e.g. null to indicate non-handling)
      lastEditorChangeTime = 0 // disable debounce even if editor focused
      onEditorChange('')
      setTimeout(() => textArea(-1).blur()) // defocus, requires dispatch on chrome
    } else if (typeof obj != 'object' || !obj.text || typeof obj.text != 'string') {
      alert(`invalid return for command ${cmd} handled in item ${item.name}`)
    } else {
      const text = obj.text
      // since we are async, we need to call onEditorDone again with run/editing set properly
      // obj.{edit,run} can override defaults editing=true and run=false
      let editing = true
      let run = false
      if (obj.edit == true) editing = true
      else if (obj.edit == false) editing = false
      if (obj.run == true) run = true
      else if (obj.run == false) run = false
      // reset focus for generated text
      let textarea = textArea(-1)
      textarea.selectionStart = textarea.selectionEnd = 0
      let item = onEditorDone(text, null, false, run, editing, null, true /*ignore_command*/)
      // run programmatic initializer function if any
      try {
        if (obj.init) Promise.resolve(obj.init(item)).catch(handleError)
      } catch (e) {
        handleError(e)
        throw e
      }
    }
  }

  let sessionCounter = 0 // to ensure unique increasing temporary ids for this session
  let sessionHistory = []
  let sessionHistoryIndex = 0
  let tempIdFromSavedId = new Map<string, string>()
  let editorText = ''
  let editor
  function onEditorDone(
    text: string,
    e: any = null,
    cancelled: boolean = false,
    run: boolean = false,
    editing = null,
    attr = null,
    ignore_command = false
  ) {
    editorText = text // in case invoked without setting editorText
    const key = e?.code || e?.key
    window['_mindbox_return'] = undefined // set on non-empty returns for MindBox.create
    if (cancelled) {
      if (key == 'Escape') {
        setTimeout(() => textArea(-1).blur()) // requires dispatch on chrome
        // clear command text since it does not trigger search/navigation and is rather useless without focus
        if (text.startsWith('/')) {
          lastEditorChangeTime = 0 // disable debounce even if editor focused
          onEditorChange('')
        }
      } else {
        lastEditorChangeTime = 0 // disable debounce even if editor focused
        onEditorChange('')
      }
      return
    }

    // reset history index, update entry 0 and unshift duplicate entry
    // NOTE: we do not depend on onEditorChange keeping entry 0 updated, even though it should
    // NOTE: if event (e) is missing, this is considered a "synthetic" call not added to history
    // NOTE: if new entry would be blank or same as previous, we do not create a new entry
    if (e) {
      sessionHistoryIndex = 0
      if (sessionHistory[0] != text.trim()) {
        if (sessionHistory.length == 0) sessionHistory = [text.trim()]
        else sessionHistory[0] = text.trim()
      }
      if (sessionHistory[0].trim() && (sessionHistory.length == 1 || sessionHistory[0] != sessionHistory[1]))
        sessionHistory.unshift(sessionHistory[0])
    }

    let origText = text // if text is modified, caret position will be reset
    let time = Date.now() // default time is current, can be past if undeleting
    let clearLabel = false // force clear, even if text starts with tag
    if (editing == null) {
      // NOTE: for non-synthetic calls, default is to edit unless any 2+ modifiers are held
      //       (some modifier combinations, e.g. Ctrl+Alt, may be blocked by browsers)
      editing = e && (e.metaKey ? 1 : 0) + (e.ctrlKey ? 1 : 0) + (e.altKey ? 1 : 0) < 2
    }
    // disable running if Shift is held
    if (e && e.shiftKey) run = false
    // force editing if text is empty
    if (!text.trim()) editing = true

    if (!ignore_command) {
      switch (text.trim()) {
        case '/_signout': {
          if (!signedin) {
            alert('already signed out')
            return
          }
          signOut()
          return
        }
        case '/_signin': {
          if (signedin) {
            alert('already signed in')
            return
          }
          signIn()
          return
        }
        case '/_reload': {
          location.reload()
          return
        }
        case '/_count': {
          text = `${editingItems.length} items are selected`
          break
        }
        case '/_times': {
          if (editingItems.length == 0) {
            alert('/_times: no item selected')
            return
          }
          const item = items[editingItems[0]]
          text = `${new Date(item.time)}\n${new Date(item.updateTime)}\n${new Date(item.createTime)}`
          break
        }
        case '/_edit': {
          if (editingItems.length == 0) {
            alert('/_edit: no item selected')
            return
          }
          const item = items[editingItems[0]]
          // make installed item (persistently) editable
          if (item.attr && !item.attr.editable) {
            item.attr.editable = true
            saveItem(item.id)
          }
          item.editable = true
          tick().then(() => textArea(item.index)?.focus())
          lastEditorChangeTime = 0 // disable debounce even if editor focused
          onEditorChange('')
          return
        }
        case '/_unedit': {
          if (editingItems.length == 0) {
            alert('/_unedit: no item selected')
            return
          }
          const item = items[editingItems[0]]
          // make installed item (persistently) uneditable
          if (item.attr && item.attr.editable) {
            item.attr.editable = false
            saveItem(item.id)
          }
          item.editable = false
          lastEditorChangeTime = 0 // disable debounce even if editor focused
          onEditorChange('')
          return
        }
        case '/_updates': {
          if (editingItems.length == 0) {
            alert('/_updates: no item selected')
            return
          }
          const item = items[editingItems[0]]
          if (!item.attr) {
            alert(`/_updates: selected item ${item.name} was not installed via /_install command`)
            return
          }
          const attr = item.attr
          const history = attr.source.replace('/blob/', '/commits/')
          const installed_update = `https://github.com/${attr.owner}/${attr.repo}/commit/${attr.sha}`
          const max_updates_shown = 5
          const Octokit = window['Octokit']
          const github = attr.token ? new Octokit({ auth: attr.token }) : new Octokit()

          ;(async () => {
            try {
              let { data } = await github.repos.listCommits({ ...attr, sha: attr.branch, per_page: 100 })
              const time_ago = itemTimeString(new Date(data[0].commit.author.date).getTime(), true) + ' ago'
              // _prepend_ any updates for any embeds so that they are treated as updates to container item
              if (attr.embeds) {
                for (let embed of attr.embeds) {
                  const resp = await github.repos.listCommits({
                    ...attr,
                    path: embed.path,
                    sha: attr.branch,
                    per_page: 100,
                  })
                  const index = resp.data.findIndex(commit => commit.sha == embed.sha)
                  if (index >= 0) resp.data.length = index
                  const embed_source = `https://github.com/${attr.owner}/${attr.repo}/blob/${attr.branch}/${embed.path}`
                  for (let update of resp.data)
                    update.commit.message = `[${embed.path}](${embed_source}) ` + update.commit.message.trim()
                  data = resp.data.concat(data)
                }
              }
              if (data[0].sha == attr.sha) {
                // no updates!
                _modal({
                  content:
                    `No updates available for [${attr.path}](${attr.source}).  \n` +
                    `[Last update](${installed_update}) (_installed_) was ${time_ago}.  \n` +
                    `See [history](${history}) for past updates.`,
                })
              } else {
                // there are updates!
                const index = data.findIndex(commit => commit.sha == attr.sha)
                let update_count = index < 0 ? data.length + '+' : index
                update_count += update_count === 1 ? ' update' : ' updates'
                if (index >= 0) data.length = index
                _modal({
                  content:
                    `${update_count} available for [${attr.path}](${attr.source}):  \n` +
                    data
                      .sort(
                        (a, b) => new Date(b.commit.author.date).getTime() - new Date(a.commit.author.date).getTime()
                      )
                      .slice(0, max_updates_shown)
                      .map(
                        update =>
                          `- [${update.sha.slice(0, 7)}](${update.html_url}) ${update.commit.message.trim()}  \n`
                      )
                      .join('') +
                    (data.length > max_updates_shown ? `- ... +${data.length - max_updates_shown} more  \n` : '') +
                    '\n' +
                    `Last [installed update](${installed_update}) was ${time_ago}.  \n` +
                    `See [history](${history}) for all updates.`,
                })
              }
            } catch (e) {
              console.error(e)
            }
          })()

          lastEditorChangeTime = 0 // disable debounce even if editor focused
          onEditorChange('')
          return
        }
        case '/_dependencies': {
          if (editingItems.length == 0) {
            alert('/_dependencies: no item selected')
            return
          }
          if (editingItems.length > 1) {
            alert('/_dependencies: too many items selected')
            return
          }
          text = items[editingItems[0]].depsString
          clearLabel = true
          break
        }
        case '/_dependents': {
          if (editingItems.length == 0) {
            alert('/_dependents: no item selected')
            return
          }
          if (editingItems.length > 1) {
            alert('/_dependents: too many items selected')
            return
          }
          text = items[editingItems[0]].dependentsString
          clearLabel = true
          break
        }
        case '/_backup': {
          if (readonly) return
          let added = 0
          items.forEach(item => {
            firestore()
              .collection('history')
              .add({
                item: item.id,
                user: user.uid,
                time: item.time,
                text: item.text,
              })
              .then(doc => {
                console.debug(`"added ${++added} of ${items.length} items to history`)
              })
              .catch(console.error)
          })
          return
        }
        case '/_welcome': {
          firestore()
            .collection('items')
            .doc('QbtH06q6y6GY4ONPzq8N')
            .get()
            .then(doc => onEditorDone(doc.data().text, null, false, false, false, null, true /*ignore command*/))
            .catch(console.error)
          return
        }
        case '/_tweet': {
          if (editingItems.length == 0) {
            alert('/_tweet: no item selected')
            return
          }
          if (editingItems.length > 1) {
            alert('/_tweet: too many items selected')
            return
          }
          let item = items[editingItems[0]]
          location.href = 'twitter://post?message=' + encodeURIComponent(item.text)
          return
        }
        case '/_duplicate': {
          if (editingItems.length == 0) {
            alert('/_duplicate: no item selected')
            return
          }
          if (editingItems.length > 1) {
            alert('/_duplicate: too many items selected')
            return
          }
          let item = items[editingItems[0]]
          time = item.time
          text = item.text
          editing = true
          break
        }
        case '/_undelete': {
          if (deletedItems.length == 0) {
            alert('/_undelete: nothing to undelete (in this session)')
            return
          }
          // NOTE: undelete command does NOT restore item id and associated history in firebase or github
          time = deletedItems[0].time
          attr = deletedItems[0].attr
          text = deletedItems[0].text
          deletedItems.shift()
          editing = false
          break
        }
        case '/_invert': {
          inverted = !inverted
          localStorage.setItem('mindpage_inverted', inverted ? 'true' : 'false')
          lastEditorChangeTime = 0 // disable debounce even if editor focused
          onEditorChange('')
          return
        }
        case '/_green_screen': {
          window['_green_screen'] = green_screen = !green_screen
          localStorage.setItem('mindpage_green_screen', green_screen ? 'true' : 'false')
          return
        }
        default: {
          if (text.match(/^\/\w+/)) {
            // NOTE: text is untrimmed, so no whitespace before /
            const cmd = text.match(/^\/\w+/)[0]
            let args = text
              .replace(/^\/\w+/, '')
              .replace(/([`\\$])/g, '\\$1')
              .trim()

            if (cmd == '/_zoom') {
              if (args) localStorage.setItem('mindpage_zoom', args)
              else localStorage.removeItem('mindpage_zoom')
              zoom = args // will affect next checkLayout call
              lastEditorChangeTime = 0 // disable debounce even if editor focused
              onEditorChange('')
              return
            } else if (cmd == '/_narrate') {
              narrating = !narrating
              if (narrating) {
                localStorage.setItem('mindpage_narrating', args)
                localStorage.setItem('mindpage_green_screen', 'true')
                window['_green_screen'] = green_screen = true
              } else {
                const video = document.querySelector('#webcam-video') as HTMLVideoElement
                if (video) {
                  ;(video.srcObject as any)?.getTracks().forEach(track => track.stop())
                  video.srcObject = null
                }
                localStorage.removeItem('mindpage_narrating')
              }
              lastEditorChangeTime = 0 // disable debounce even if editor focused
              onEditorChange('')
              return
            } else if (cmd == '/_example') {
              firestore()
                .collection('items')
                .where('user', '==', 'anonymous')
                .orderBy('time', 'desc')
                .get()
                .then(examples => {
                  alert(`retrieved ${examples.docs.length} example items`)
                })
                .catch(console.error)
              return
            } else if (cmd == '/_watch') {
              if (hostname != 'localhost') {
                alert(`/_watch: can not watch on ${hostname}`)
                return
              }
              let [name, file] = args.split(/\s+/)
              if (!name || !file) {
                alert(`usage: ${cmd} name file`)
                return
              }
              // look up item
              const item = _item(name)
              if (!item) {
                alert(`${cmd}: item '${name}' missing or ambiguous`)
                return
              }
              ;(async () => {
                try {
                  // look up file
                  const resp = await fetch(`/file/${file}`)
                  if (resp.status != 200) {
                    alert(`${cmd}: failed to fetch file '${file}'`)
                    return
                  }
                  const text = await resp.text()
                  if (text != item.text) {
                    alert(`${cmd}: contents of file ${file} does not match item ${name}`)
                    return
                  }
                  console.log(`watching file ${file} for item ${name} ...`)
                  item.dispatch_task(
                    `${cmd} ${file}`,
                    async () => {
                      const resp = await fetch(`/file/${file}`)
                      if (resp.status != 200) {
                        console.error(`${cmd}: failed to fetch file '${file}'`)
                        return
                      }
                      const text = await resp.text()
                      if (text != item.text) {
                        console.log(`detected changes to ${file} for item ${name}`)
                        item.write(text, '')
                      }
                    },
                    0,
                    1000
                  )
                } catch (e) {
                  console.error(`${cmd}: failed to read file ${file}: ` + e)
                  alert(`${cmd}: failed to read ${file}: ` + e)
                }
              })()
              lastEditorChangeTime = 0 // disable debounce even if editor focused
              onEditorChange('')
              return

              // const start = Date.now()
              // const resp = await fetch('/file/mind.items/util.md')
              // const text = await resp.text()
              // console.log(`local read took ${Date.now()-start}ms`)
              // text
            } else if (cmd == '/_install' || cmd == '/_update') {
              const updating = cmd == '/_update'
              // parse dependents in suffix separated using <-
              // (used below to avoid following cyclic dependencies)
              let dependents = []
              if (args.includes('<-')) {
                dependents = args
                  .substring(args.indexOf('<-'))
                  .split('<-')
                  .map(s => s.trim())
                  .filter(s => s)
                args = args.substring(0, args.indexOf('<-')).trim()
              }
              // install item from specified github source
              let [path, repo, branch, owner, token] = args.split(/\s+/)
              if (!repo) repo = 'mind.items'
              if (!branch) branch = 'master'
              if (!owner) owner = 'olcan'
              if (!token) token = localStorage.getItem('mindpage_github_token') // try localStorage
              if (!token) token = null // no token, use unauthenticated client
              if (!path) {
                alert(`usage: ${cmd} path [repo branch owner token]`)
                return
              }
              // drop optional leading slash in paths for consistency
              if (path.startsWith('/')) path = path.substring(1)
              if (path.startsWith('/')) {
                alert(`invalid path '${path}'`)
                return
              }
              // if path is specified as #label, extract path from named item
              // note path==label is not required in general, indeed labels could be missing or non-unique
              // however path==label is required for dependencies (see below) so their paths can be inferred
              let label
              if (path.startsWith('#')) {
                label = path
                if (idsFromLabel.get(label.toLowerCase())?.length > 1) {
                  alert(`can not update multiple items labeled ${label}`)
                  return
                } else if (!_exists(label)) {
                  alert(`missing item ${label}`)
                  return
                }
                path = _item(label).attr.path
              }
              // check file extension in path
              // default (and preferred) extension is .md for installable items
              // .markdown is also supported but preferred more for sync/backup/export purposes
              if (!path.includes('.')) path += '.md'
              else if (!path.endsWith('.md') && !path.endsWith('.markdown')) {
                alert(`${cmd}: invalid file extension in path '${path}'`)
                return
              }
              const Octokit = window['Octokit']
              const github = token ? new Octokit({ auth: token }) : new Octokit()
              const start = Date.now()

              // clear command and return promise for processing ...
              lastEditorChangeTime = 0 // disable debounce even if editor focused
              onEditorChange('')
              return (window['_mindbox_return'] = (async () => {
                try {
                  // if no token, prompt for it, also mentioning rate limits
                  if (!token) {
                    await _modal_close() // force-close any existing modal
                    token = await _modal({
                      content: `MindPage needs your [Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token) for installing items from GitHub. Token is optional for public repos but is strongly recommended as token-free access can be severely throttled by GitHub.`,
                      confirm: 'Use Token',
                      cancel: 'Skip',
                      input: '',
                      password: false,
                    })
                    if (token) localStorage.setItem('mindpage_github_token', token)
                    else token = null // no token, use unauthenticated client
                  }
                  // NOTE: force-closing modals is especially important since install/update can be invoked recursively for dependencies ...
                  await _modal_close() // force-close any existing modal
                  _modal({
                    content: (updating ? 'Updating' : 'Installing') + ` ${updating && label ? label : path} ...`,
                    background: 'block',
                  })
                  // retrieve commit sha (allows comparison to later versions)
                  const {
                    data: [{ sha = 0 } = {}],
                  } = await github.repos.listCommits({
                    owner,
                    repo,
                    sha: branch,
                    path,
                    per_page: 1,
                  })
                  if (!sha) throw new Error(`${cmd}: missing commit for ${path}`)
                  // retrieve text at this commit sha
                  const { data } = await github.repos.getContent({ owner, repo, ref: sha, path })
                  let text = decodeBase64(data.content)

                  const attr = {
                    sha,
                    editable: false,
                    source: `https://github.com/${owner}/${repo}/blob/${branch}/${path}`,
                    path,
                    repo,
                    branch,
                    owner,
                    token /* to authenticate for updates */,
                    embeds: null, // may be filled in below
                  }

                  // trim spaces, esp. since github likes to add an extra line
                  // this is fine since we use commit sha to detect changes
                  text = text.trim()
                  // extract embed paths
                  let embeds = []
                  function resolve_embed_path(path, attr) {
                    if (path.startsWith('/') || !attr.path.includes('/', 1)) return path
                    return attr.path.substr(0, attr.path.lastIndexOf('/')) + '/' + path
                  }
                  for (let [m, sfx, body] of text.matchAll(/```\S+:(\S+?)\n(.*?)\n```/gs))
                    if (sfx.includes('.')) embeds.push(resolve_embed_path(sfx, attr))
                  // fetch embed text and latest commit sha
                  let embed_text = {}
                  for (let path of _.uniq(embeds)) {
                    try {
                      const {
                        data: [{ sha = 0 } = {}],
                      } = await github.repos.listCommits({
                        owner,
                        repo,
                        sha: branch,
                        path,
                        per_page: 1,
                      })
                      if (!sha) throw new Error(`${cmd}: missing commit for embed ${path}`)
                      const { data } = await github.repos.getContent({
                        owner,
                        repo,
                        ref: sha,
                        path,
                      })
                      embed_text[path] = decodeBase64(data.content)
                      attr.embeds = (attr.embeds ?? []).concat({ path, sha })
                    } catch (e) {
                      throw new Error(`failed to embed '${path}'; error: ${e}`)
                    }
                  }
                  // replace embed block body with embed contents
                  text = text.replace(/```(\S+):(\S+?)\n(.*?)\n```/gs, (m, pfx, sfx, body) => {
                    if (sfx.includes('.')) {
                      const path = resolve_embed_path(sfx, attr)
                      // store original body in attr.embeds to allow item to be edited and pushed back
                      // note if same path is embedded multiple times, only the last body is retained
                      attr.embeds.find(e => e.path == path).body = body
                      return '```' + pfx + ':' + sfx + '\n' + embed_text[path] + '\n```'
                    }
                    return m
                  })

                  // extract label from text and check existence if updating
                  let item
                  label = parseLabel(text)
                  // if updating, label should uniquely match an existing (named) item
                  if (updating) {
                    if (!label) throw new Error(`${cmd}: could not determine item name for update from ${path}`)
                    else if (idsFromLabel.get(label.toLowerCase())?.length > 1)
                      throw new Error(`${cmd}: found multiple items labeled ${label}, can not update from ${path}`)
                    else if (!_exists(label)) throw new Error(`${cmd}: missing item ${label} to update from ${path}`)
                  }

                  // install/update dependencies based on item text
                  // dependency paths MUST match the (resolved) hidden tags
                  if (label) {
                    const deps = resolveTags(
                      label,
                      parseTags(text).hidden.filter(t => !isSpecialTag(t))
                    )
                    for (let dep of deps) {
                      const dep_path = dep.slice(1) // path assumed same as tag
                      if (dep_path.startsWith('/'))
                        // should not happen w/ resolved tags
                        throw new Error('invalid dependency path: ' + dep_path)
                      // skip circular dependencies
                      if (dependents.includes(dep)) {
                        console.warn(`${cmd}: skipping circular dependency ${dep} for ${label}`)
                        continue
                      }
                      const update = _exists(dep, false /*allow_multiple*/) // update if possible
                      console.log((update ? 'updating' : 'installing') + ` dependency ${dep} for ${label} ...`)
                      const command = `${update ? '/_update' : '/_install'} ${dep_path} ${repo} ${branch} ${owner} ${
                        token || ''
                      } <- ${[label, ...dependents].join(' <- ')}`
                      const dep_item = await onEditorDone(command)
                      if (!dep_item) {
                        throw new Error(
                          `${cmd}: failed to ${update ? 'update' : 'install'} dependency ${dep} for ${label}`
                        )
                      } else if (dep_item.name.toLowerCase() != dep.toLowerCase()) {
                        throw new Error(
                          `${cmd}: invalid name ${dep_item.name} for ${
                            update ? 'updated' : 'installed'
                          } dependency ${dep} of ${label}`
                        )
                      }
                    }
                  }

                  // replace existing item or create new item
                  if (label && _exists(label, false /*allow_multiple*/)) {
                    // confirm replacement if installing
                    if (!updating) {
                      await _modal_close() // force-close any existing modal
                      const replace = await _modal_update({
                        content: `Replace existing ${label}?`,
                        confirm: 'Replace',
                        cancel: 'Cancel',
                        background: 'cancel',
                      })
                      if (!replace) {
                        console.warn(`cancelled installation of ${path} due to existing item ${label}`)
                        return
                      }
                    }
                    item = _item(label)
                    // confirm if updating "pushable" item w/ unpushed changes
                    if (updating && item.pushable) {
                      await _modal_close() // force-close any existing modal
                      const overwrite = await _modal({
                        content: `Overwrite unpushed changes in ${item.name}?`,
                        confirm: 'Overwrite',
                        cancel: 'Cancel',
                        background: 'cancel',
                      })
                      if (!overwrite) {
                        console.warn(`cancelled update of ${path} due to unpushed changes in ${item.name}`)
                        return
                      }
                    }
                    __item(item.id).attr = Object.assign(attr, { editable: item.attr.editable })
                    item.write(text, '')
                  } else {
                    item = onEditorDone(text, null, false, false, false, attr, true /*ignore_command*/)
                  }

                  // wait for dom update
                  await tick()
                  await update_dom()

                  // invoke _on_install(item) if defined
                  await _modal_close() // allow _on_install to display own modals
                  if (item.text.includes('_on_install')) {
                    try {
                      _item(item.id).eval(`if (typeof _on_install == 'function') _on_install(_item('${item.id}'))`, {
                        trigger: 'command',
                      })
                    } catch (e) {} // already logged, just continue
                  }

                  // clear pushable flag to resume auto-side-push to source
                  item.pushable = false

                  // log completion and return item to indicate successful install/update
                  console.log(
                    (updating ? 'updated' : 'installed') + ` ${path} (${item.name}) in ${Date.now() - start}ms`
                  )
                  return item
                } catch (e) {
                  console.error(`${updating ? 'update' : 'install'} failed for ${path}: ` + e)
                  alert(`${updating ? 'update' : 'install'} failed for ${path}: ` + e)
                } finally {
                  await _modal_close()
                }
              })())
            } else if (_exists('#commands' + cmd)) {
              function handleError(e) {
                const log = _item('#commands' + cmd).get_log({ since: 'eval', level: 'error' })
                let msg = [`#commands${cmd} run(\`${args}\`) failed:`, ...log, e].join('\n')
                alert(msg)
              }
              try {
                let cmd_item = items[_item('#commands' + cmd).index]
                Promise.resolve(
                  _item('#commands' + cmd).eval(`run(\`${args}\`)`, {
                    trigger: 'command',
                    async: cmd_item.deepasync, // run async if item is async or has async deps
                    async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
                  })
                )
                  .then(obj => {
                    handleCommandReturn(cmd, cmd_item, obj, handleError)
                  })
                  .catch(handleError)
              } catch (e) {
                handleError(e)
                throw e
              }
              return
            } else {
              // as last effort, invoke on first listener that handles _on_command_<name>
              let found_listener = false
              for (let item of items) {
                if (!item.listen) continue
                const name = cmd.substring(1)
                if (!item.text.includes('_on_command_' + name)) continue
                found_listener = true
                function handleError(e) {
                  const log = _item(item.id).get_log({ since: 'eval', level: 'error' })
                  let msg = [`${item.name} _on_command_${name}(\`${args}\`) failed: `, ...log, e].join('\n')
                  alert(msg)
                }
                const ret = _item(item.id).eval(
                  `(typeof _on_command_${name} == 'function' ? _on_command_${name}(\`${args}\`) : null)`,
                  {
                    trigger: 'listen',
                    async: item.deepasync, // run async if item is async or has async deps
                    async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
                  }
                )
                if (ret === null) continue // did not handle command
                Promise.resolve(ret)
                  .then(obj => {
                    handleCommandReturn(cmd, item, obj, handleError)
                  })
                  .catch(handleError)
                found_listener = true
                break // stop on first listener handling command
              }
              if (!found_listener) alert(`unknown command ${cmd} ${args}`)
              return
            }
          } else if (text.match(/^\/\s+/s)) {
            // clear /(space) as a mechanism to disable search
            // (onEditorChange already ignores text starting with /)
            // text = text.replace(/^\/\s+/s, "");
          }
          // editing = text.trim().length == 0; // if text is empty, continue editing
        }
      }
    }

    let itemToSave = { user: user.uid, time, attr, text }
    let item = initItemState(_.clone(itemToSave), 0, {
      id: (Date.now() + sessionCounter++).toString(), // temporary id for this session only
      editing: editing,
      saving: !editing,
      savedId: null, // filled in below after save
      savedTime: 0, // filled in onItemSaved
      savedAttr: null, // filled in onItemSaved
      savedText: '', // filled in onItemSaved (also means delete on cancell, no confirm on delete)
    })
    items = [item, ...items]

    // update indices as needed by itemTextChanged
    indexFromId = new Map<string, number>()
    items.forEach((item, index) => indexFromId.set(item.id, index))
    itemTextChanged(0, text)

    // if text is not synthetic and starts with a tag, keep if non-unique label
    // (useful for adding labeled items, e.g. todo items, without losing context)
    editorText =
      e /* e == null for synthetic calls, e.g. from commands */ &&
      !clearLabel &&
      items[0].label &&
      !items[0].labelUnique &&
      items[0].labelText &&
      editorText.startsWith(items[0].labelText + ' ')
        ? items[0].labelText + ' '
        : ''

    // hideIndex++; // show one more item
    lastEditorChangeTime = 0 // disable debounce even if editor focused
    onEditorChange(editorText) // integrate new item at index 0
    // retreat to minimal hide index to focus on new item
    // hideIndex = hideIndexMinimal;

    // hide dotted items when creating new item
    // reduces jump to new item editor
    // helps avoid loss of focus if new item editor goes off screen on ios
    showDotted = false

    if (run) {
      // NOTE: appendJSOutput can trigger _writes that trigger saveItem, which will be skipped due to saveId being null
      appendJSOutput(indexFromId.get(item.id))
      text = itemToSave.text = item.text // no need to update editorText
    }

    // maintain selection on created textarea if editing
    if (editing) {
      let textarea = textArea(-1)
      let selectionStart = textarea.selectionStart
      let selectionEnd = textarea.selectionEnd
      // for generated (vs typed) items, focus at the start for better context and no scrolling up
      if (text != origText) selectionStart = selectionEnd = 0
      // NOTE: update_dom here does not work on iOS, presumably because it leaves too much time between user input and focus, causing system to reject the change of focus
      tick().then(() => {
        const index = indexFromId.get(item.id)
        if (index == undefined) return
        let textarea = textArea(index)
        if (!textarea) {
          console.error('missing textarea for new item')
          return
        }
        textarea.focus()
        textarea.selectionStart = selectionStart
        textarea.selectionEnd = selectionEnd

        // scroll to caret position ...
        // NOTE: it turns out this may have been unnecessary and causing over-scrolling on iphone, see comment in restoreItemEditor
        // restoreItemEditor(item.id);

        // NOTE: on the iPad, there is an odd bug where a tap-to-click (but not a full click) on the trackpad on create button can cause a semi-focused state where activeElement has changed but the element does not show caret or accept input except some keys such as tab, AND selection reverts to 0/0 after ~100ms (as if something is momentarily clearing the textarea, perhaps due to some external keyboard logic), and we could not figure out any reason (it is not the editor's onMount or other places where selection is set) or other workaround (e.g. using other events to trigger onCreate), except to check for reversion to 0/0 after 100ms and fix if any
        if (selectionStart > 0 || selectionEnd > 0) {
          setTimeout(() => {
            if (textarea.selectionStart == 0 && textarea.selectionEnd == 0) {
              textarea.selectionStart = selectionStart
              textarea.selectionEnd = selectionEnd
            }
          }, 100)
        }
      })
    }

    // invoke _on_create on all _listen items
    setTimeout(() => {
      items.forEach(item => {
        if (!item.listen) return
        if (!item.text.includes('_on_create')) return
        try {
          _item(item.id).eval(
            `if (typeof _on_create == 'function') _on_create(\`${editorText.replace(/([`\\$])/g, '\\$1')}\`)`,
            {
              trigger: 'listen',
            }
          )
        } catch (e) {} // already logged, just continue
      })
    })

    encryptItem(itemToSave)
      .then(itemToSave => {
        ;(readonly
          ? Promise.resolve({ id: item.id, delete: Promise.resolve })
          : firestore().collection('items').add(itemToSave)
        )
          .then(doc => {
            let index = indexFromId.get(item.id) // since index can change
            tempIdFromSavedId.set(doc.id, item.id)
            if (index == undefined) {
              // item was deleted before it could be saved
              doc.delete().catch(console.error)
              return
            }
            item.savedId = doc.id

            // if editing, we do not call onItemSaved so save is postponed to post-edit, and cancel = delete
            if (!item.editing) onItemSaved(item.id, itemToSave)

            // also save to history (using persistent doc.id) ...
            if (!readonly) {
              firestore()
                .collection('history')
                .add({ item: doc.id, ...itemToSave })
                .catch(console.error)
            }
          })
          .catch(console.error)
      })
      .catch(console.error)

    return (window['_mindbox_return'] = _item(item.id)) // return created item
  }

  function focusOnNearestEditingItem(index: number) {
    // console.debug("focusOnNearestEditingItem", index, editingItems);
    let near = Math.min(...editingItems.filter(i => i > index && i < hideIndex))
    if (near == Infinity) near = Math.max(...[-1, ...editingItems.filter(i => i < hideIndex)])
    focusedItem = near
    if (near == -1) return // do not auto-focus on editor
    tick().then(() => textArea(near).focus())
  }

  function onItemSaved(id: string, savedItem) {
    // console.debug("saved item", id);
    decryptItem(savedItem).then(savedItem => {
      const index = indexFromId.get(id)
      if (index == undefined) return // item was deleted
      let item = items[index]
      item.savedTime = savedItem.time
      item.savedAttr = _.cloneDeep(savedItem.attr) // just in case not cloned already
      item.savedText = savedItem.text
      item.saving = false
      items[index] = item // trigger dom update
      if (item.saveClosure) {
        item.saveClosure(item.id)
        delete item.saveClosure
      }
    }) // decryptItem(savedItem)
  }

  function onItemEscape(e) {
    if (!editorText) return true // not handled
    if (!e.shiftKey) return true // not handled (want shift key also)
    editorText = ''
    forceNewStateOnEditorChange = true // force new state
    // finalizeStateOnEditorChange = true; // finalize state
    lastEditorChangeTime = 0 // disable debounce even if editor focused
    onEditorChange(editorText)
    // restore focus (can be necessary e.g. if edited item was also "target" item)
    const focusElement = document.activeElement as HTMLElement
    setTimeout(() => focusElement.focus())
    return false // escape handled
  }

  let lastEditTime = 0 // updated in onItemEdited
  let layoutPending = false
  function onItemResized(id, container, trigger: string) {
    if (!container) return
    const index = indexFromId.get(id)
    if (index == undefined) return
    let item = items[index]
    // exclude any ._log elements since they are usually collapsed
    let logHeight = 0
    container.querySelectorAll('._log').forEach(log => (logHeight += log.offsetHeight))
    const height = container.offsetHeight - logHeight
    const prevHeight = item.height
    if (prevHeight == 0) {
      if (height == 0) console.warn(`zero initial height for item ${item.name} at position ${index + 1}`)
      if (item.resolve_render) item.resolve_render(height)
      item.resolve_render = null
    }
    if (height == prevHeight) return // nothing has changed
    if (height == 0 && prevHeight > 0) {
      console.warn(`ignoring zero height (was ${prevHeight}) for item ${item.name} at position ${index + 1}`)
      return
    }
    // console.debug(`item ${item.name} height changed from ${prevHeight}} to ${height}`);

    item.height = height
    if (item.hidden) return // skip layout update for hidden item

    // NOTE: Heights can fluctuate due to async scripts that generate div contents (e.g. charts), especially where the height of the output is not known and can not be specified via CSS, e.g. as an inline style on the div. We tolerate these changes for now, but if this becomes problematic we can skip or delay some layout updates, especially when the height is decreasing, postponing layout update to other events, e.g. reordering of items.
    if (
      height == 0 ||
      prevHeight == 0 ||
      Math.abs(height - prevHeight) > 300
      // height < 0.5 * prevHeight ||
      // height > prevHeight + 100
    ) {
      if (!layoutPending) {
        layoutPending = true
        const tryLayout = () => {
          // NOTE: checking lastEditTime helps reduce editor issues (e.g. jumping of cursor) related to resizing while editing, but does NOT solve all issues, especially those not related to resizing.
          if (Date.now() - lastEditTime < 500 || Date.now() - lastScrollTime < 500) {
            // try again later
            setTimeout(tryLayout, 250)
            return
          }
          updateItemLayout()
          layoutPending = false
        }
        // if totalItemHeight == 0, then we have not yet done any layout with item heights available, so we do not want to delay too long, but just want to give it enough time for heights to be reasonably accurate
        setTimeout(tryLayout, totalItemHeight > 0 ? 250 : 50) // try now
      }
    }
  }

  function itemShowLogs(id: string, autohide_after: number = 15000) {
    let index = indexFromId.get(id)
    if (index == undefined) return
    items[index].showLogs = true
    const dispatchTime = (items[index].showLogsTime = Date.now())
    if (autohide_after > 0) {
      setTimeout(() => {
        let index = indexFromId.get(id)
        if (index == undefined) return
        if (dispatchTime == items[index].showLogsTime) items[index].showLogs = false
      }, autohide_after)
    }
  }

  function removeBlock(text: string, type: string) {
    return text.replace(blockRegExp(type), '')
  }

  function clearBlock(text: string, type: string) {
    return text.replace(blockRegExp(type), (m, pfx, t) => pfx + '```' + t + '\n```')
  }

  function appendBlock(text: string, type: string, block) {
    if (typeof block != 'string') block = '' + block
    if (block.length > 0 && block[block.length - 1] != '\n') block += '\n'
    const regex = blockRegExp(type)
    let count = 0
    text = text.replace(regex, (m, pfx, t) => pfx + '```' + t + '\n' + (count++ == 0 ? block : '') + '```')
    if (count == 0) text = [text, '```' + type + '\n' + block + '```'].join('\n')
    return text
  }

  function appendJSOutput(index: number): string {
    let item = items[index]
    if (!item.runnable) return item.text // item not runnable, ignore
    // check js_input
    const async = item.deepasync
    let jsin = extractBlock(item.text, 'js_input')
    // if js_input block is missing entirely (not just empty), then evaluate "(return await) _run()"
    if (!jsin && !item.lctext.match(/\s*```js_input(?:_hidden|_removed)?(?:\s|$)/)) {
      jsin = async ? 'return await _run()' : '_run()'
      jsin = `if (typeof _run === 'undefined') { console.error('_run undefined; enabling #_tag may be missing for *_input block (e.g. #_typescript for ts_input)') } else { ${jsin} }`
    }
    if (!jsin) return item.text // input missing or empty, ignore
    let jsout
    try {
      jsout = _item(item.id).eval(jsin, { debug: item.debug, async, trigger: 'run' /*|create*/ })
    } catch (e) {} // already logged, just continue
    // ignore output if Promise
    if (jsout instanceof Promise) jsout = undefined
    // stringify output
    if (jsout !== undefined && typeof jsout != 'string') jsout = '' + JSON.stringify(jsout)
    const outputConfirmLength = 64 * 1024
    if (jsout !== undefined && jsout.length >= outputConfirmLength)
      if (!confirm(`Write ${jsout.length} bytes (_output) into ${item.name}?`)) jsout = undefined
    // append _output and _log and update for changes
    if (jsout !== undefined) item.text = appendBlock(item.text, '_output', jsout)
    _item(item.id).write_log() // auto-write log
    // NOTE: index can change during JS eval due to _writes
    itemTextChanged(indexFromId.get(item.id), item.text)
    return item.text
  }

  function saveItem(id: string) {
    // console.debug("saving item", id);
    const index = indexFromId.get(id)
    if (index == undefined) return // item deleted
    let item = items[index]
    // if item is already saving, set saveClosure and return (no need to chain)
    if (item.saving) {
      item.saveClosure = saveItem
      return
    }
    if (!item.savedId) {
      // NOTE: this can happen due to appendJSOutput for new item on onEditorDone()
      // console.error("item is not being saved but also does not have its permanent id");
      return
    }
    item.saving = true
    let itemToSave = {
      // NOTE: using set is no longer necessary since we are no longer converting older unencrypted items, and update is desirable because it fails (with permission error) when the item has been deleted, preventing zombie items due to saves from stale tabs (especially background writes/saves that trigger without chance to reload).
      // user: user.uid, // allows us to use set() instead of update()
      time: item.time,
      attr: _.cloneDeep(item.attr),
      text: item.text,
    }

    if (readonly) {
      setTimeout(() => onItemSaved(item.id, itemToSave))
      return
    }

    encryptItem(itemToSave).then(itemToSave => {
      firestore()
        .collection('items')
        .doc(item.savedId)
        .update(itemToSave)
        .then(() => {
          onItemSaved(item.id, itemToSave)
        })
        .catch(console.error)

      // also save to history ...
      firestore()
        .collection('history')
        .add({ item: item.savedId, user: user.uid, ...itemToSave })
        .catch(console.error)
    }) // encryptItem(itemToSave)
  }

  // https://stackoverflow.com/a/9039885
  function isIOS() {
    if (typeof navigator == 'undefined') return false
    return (
      ['iPad Simulator', 'iPhone Simulator', 'iPod Simulator', 'iPad', 'iPhone', 'iPod'].includes(navigator.platform) ||
      // iPad on iOS 13 detection
      (navigator.userAgent.includes('Mac') && 'ontouchend' in document)
    )
  }
  // https://stackoverflow.com/a/6031480
  function isAndroid() {
    if (typeof navigator == 'undefined') return false
    return navigator.userAgent.toLowerCase().includes('android')
  }

  const android = isAndroid()
  const ios = isIOS()

  function deleteItem(index): boolean {
    const item = items[index]
    // if item has saved text (not new item) and unique label, confirm deletion
    if (item.savedText && item.labelUnique && !confirm(`Delete ${item.name}?`)) {
      item.text = item.savedText // in case text was cleared to trigger deletion on onItemEditing
      return false
    }
    itemTextChanged(index, '') // clears label, deps, etc
    items.splice(index, 1)
    if (index < hideIndex) hideIndex-- // back up hide index
    // update indices as needed by onEditorChange
    indexFromId = new Map<string, number>()
    items.forEach((item, index) => indexFromId.set(item.id, index))
    lastEditorChangeTime = 0 // disable debounce even if editor focused
    onEditorChange(editorText) // deletion can affect ordering (e.g. due to missingTags)
    deletedItems.unshift({
      time: item.savedTime,
      attr: _.cloneDeep(item.savedAttr),
      text: item.savedText,
    }) // for /undelete
    if (!readonly && item.savedId) {
      firestore().collection('items').doc(item.savedId).delete().catch(console.error)
    }
    return true
  }

  function onItemEditing(
    index: number,
    editing: boolean,
    cancelled: boolean = false,
    run: boolean = false,
    e: KeyboardEvent = null
  ) {
    // console.debug(`item ${index} editing: ${editing}, editingItems:${editingItems}, focusedItem:${focusedItem}`);
    let item = items[index]

    // update time for non-log item
    if (!item.log) item.time = Date.now()

    // if cancelled, restore savedText
    // we do not restore time so item remains "soft touched"
    // we also do not restore attr
    if (cancelled) {
      // item.time = item.savedTime;
      // item.attr = _.cloneDeep(item.savedAttr);
      item.text = item.savedText
    }

    if (editing) {
      // started editing
      editingItems.push(index)
      lastEditorChangeTime = 0 // disable debounce even if editor focused
      onEditorChange(editorText) // editing state (and possibly time) has changed
      // retreat to minimal hide index to focus on edited item
      hideIndex = hideIndexMinimal
      // layout above does not trigger focus/scroll since editor is not rendered at that point
      // if (ios) textArea(-1).focus(); // allows refocus outside of click handler
      // on ios we still need a well-timed focus() call to bring up the keyboard
      // as in onEditorDone, update_dom turns out to be too slow to switch focus but tick works
      const dispatchTime = Date.now()
      tick().then(() => {
        textArea(item.index)?.focus()
        lastFocusedEditElement = textArea(item.index) // prevent refocus/scroll in layout (e.g. after resize)
        if (lastScrollTime < dispatchTime) restoreItemEditor(item.id) // scroll to caret
      })
    } else {
      // stopped editing
      editingItems.splice(editingItems.indexOf(index), 1)
      // NOTE: onItemFocused may not get invoked (and item.focused may remain true) on destroyed editors
      if (focusedItem == index) {
        focusedItem = -1
        item.focused = false
      }
      if (item.text.trim().length == 0) {
        // delete
        deleteItem(index)
      } else {
        itemTextChanged(index, item.text)
        // clear _output and execute javascript unless cancelled
        if (run && !cancelled && item.runnable /* just updated */) {
          // clear *_output blocks as they should be re-generated
          item.text = clearBlock(item.text, '\\w*?_output')
          // remove *_log blocks so errors do not leave empty blocks
          item.text = removeBlock(item.text, '\\w*?_log')
          itemTextChanged(index, item.text) // updates tags, label, deps, etc before JS eval
          appendJSOutput(index)
        }
        // remember item for resumeLastEdit
        // if (!cancelled) lastEditItem = item.id;
        lastEditItem = item.id
        // if alt/option+cmd are held together, restore (i.e. do not modify) savedTime
        if (e?.altKey && e?.metaKey) item.time = item.savedTime
        if (
          !cancelled &&
          (item.time != item.savedTime || item.text != item.savedText || !_.isEqual(item.attr, item.savedAttr))
        )
          saveItem(item.id)
        onEditorChange(editorText) // item time and/or text may have changed
      }

      // NOTE: we do not focus back up on the editor unless we are already at the top
      //       (especially bad on iphone due to lack of keyboard focus benefit)
      if (editingItems.length > 0 || document.body.scrollTop == 0) focusOnNearestEditingItem(index)

      // scroll up to item to bring it to ~upper-middle of page, snapping up to header
      // (most helpful for items that are much taller when editing)
      if (!narrating) {
        tick()
          .then(update_dom)
          .then(() => {
            const div = document.querySelector('#super-container-' + item.id)
            if (!div) return // item deleted or hidden
            const itemTop = (div as HTMLElement).offsetTop
            if (itemTop - 100 < document.body.scrollTop)
              document.body.scrollTo(0, Math.max(headerdiv.offsetTop, itemTop - innerHeight / 4))
          })
      }
    }
  }

  // WARNING: onItemFocused may NOT be invoked when editor is destroyed
  function onItemFocused(index: number, focused: boolean) {
    if (focused) {
      focusedItem = index
      focus() // ensure window focus
    } else focusedItem = -1
    // console.debug(
    //   `item ${index} focused: ${focused}, focusedItem:${focusedItem}`
    // );
  }

  function onItemEdited(index: number, text: string) {
    lastEditTime = Date.now()
  }

  function onItemRun(index: number = -1, touch_first = true) {
    if (index < 0) index = focusedItem
    let item = items[index]
    // maintain selection on textarea if editing
    if (item.editing) {
      let textarea = textArea(index)
      let selectionStart = textarea.selectionStart
      let selectionEnd = textarea.selectionEnd
      tick().then(() => {
        let textarea = textArea(indexFromId.get(item.id))
        if (!textarea) return
        textarea.selectionStart = selectionStart
        textarea.selectionEnd = selectionEnd
      })
    }
    const runItem = () => {
      const index = indexFromId.get(item.id)
      if (index === undefined) return // item deleted
      // clear *_output blocks as they should be re-generated
      item.text = clearBlock(item.text, '\\w*?_output')
      // remove *_log blocks so errors do not leave empty blocks
      item.text = removeBlock(item.text, '\\w*?_log')
      itemTextChanged(index, item.text) // updates tags, label, deps, etc before JS eval
      appendJSOutput(index)
      item.time = Date.now()
      // we now save even if editing, for consistency with write() saving during edit
      // if (!item.editing) saveItem(item.id);
      saveItem(item.id)
      lastEditorChangeTime = 0 // force immediate update (editor should not be focused but just in case)
      onEditorChange(editorText) // item time/text has changed
    }
    // run immediately if touch_first == false OR if item is editing (so touch is redundant)
    if (!touch_first || item.editing) runItem()
    else {
      // touch first to avoid delayed scroll-to-top on cpu-intensive runs
      onItemTouch(index)
      tick().then(update_dom).then(runItem)
    }
  }

  function onItemTouch(index: number, e: MouseEvent = null) {
    if (items[index].log && !confirm(`modify time for #log item?\ncreation time/ordering will be lost`)) return
    if (items[index].time > newestTime) console.warn('invalid item time')
    if (e?.altKey && e?.metaKey) {
      // move item time back 1 day
      items[index].time = items[index].time - 24 * 3600 * 1000
    } else if (e?.altKey) {
      if (index == items.length - 1 || items[index].time < items[index + 1].time) {
        alert('can not move item down')
        return
      }
      items[index].time = items[index + 1].time - 1
    } else if (e?.metaKey) {
      if (index == 0 || items[index].time > items[index - 1].time) {
        alert('can not move item up')
        return
      }
      items[index].time = items[index - 1].time + 1
    } else {
      items[index].time = Date.now()
    }
    saveItem(items[index].id)
    lastEditorChangeTime = 0 // force immediate update (editor should not be focused but just in case)
    onEditorChange(editorText) // item time has changed
    // onEditorChange(""); // item time has changed, and editor cleared
  }

  function onItemUpdate(index: number) {
    onEditorDone('/_update ' + items[index].label)
  }

  function onItemPush(index: number) {
    if (!_item('#pusher')) {
      alert(`can not push ${items[index].name}, #pusher must be installed first`)
      return
    }
    onEditorDone('/push ' + items[index].label)
  }

  function editItem(index: number) {
    items[index].editing = true
    editingItems.push(index)
  }

  function restoreItemEditor(id) {
    tick()
      .then(update_dom)
      .then(() => {
        const textarea = textArea(indexFromId.get(id))
        if (!textarea) return
        textarea.focus()

        // NOTE: this prevents some consistent overscrolling on iphone (e.g. for new items created below other items, e.g. #todo items), but downside is that there may be no scrolling ipad/iphone for deep log line edits; a more recent fix was to disable restoreItemEditor call for new item creation because it may not be necessary (see onEditorDone)
        // if (ios || android) return; // ios and android have built-in focus scrolling that works better

        // update vertical padding in case it is out of date
        // could help w/ caret position calculation below, but unconfirmed empirically
        updateVerticalPadding()

        // calculate caret position
        // NOTE: following logic was originally used to detect caret on first/last line, see https://github.com/olcan/mind.page/blob/94653c1863d116662a85bc0abd8ea1cec042d2c4/src/components/Editor.svelte#L294
        const backdrop = textarea.closest('.editor')?.querySelector('.backdrop')
        if (!backdrop) return // unable to locate backdrop div for caret position
        const clone = backdrop.cloneNode(true) as HTMLDivElement
        clone.style.visibility = 'hidden'
        backdrop.parentElement.insertBefore(clone, backdrop)
        ;(clone.firstChild as HTMLElement).innerHTML =
          _.escape(textarea.value.substring(0, textarea.selectionStart)) +
          `<span>${textarea.value.substring(textarea.selectionStart) || ' '}</span>`
        const span = clone.querySelector('span')
        let elem = span as HTMLElement
        let caretTop = span.offsetTop
        while (!elem.offsetParent.isSameNode(document.body)) {
          elem = elem.offsetParent as HTMLElement
          caretTop += elem.offsetTop
        }
        clone.remove()

        // if caret is too far up or down, bring it to ~upper-middle of page
        // allow going above header for more reliable scrolling on mobile (esp. on ios)
        // if (caretTop - 100 < document.body.scrollTop || caretTop > document.body.scrollTop + innerHeight / 4)
        if (caretTop - 100 < document.body.scrollTop || caretTop > document.body.scrollTop + innerHeight - 200)
          document.body.scrollTo(0, Math.max(0, caretTop - innerHeight / 4))
      })
  }

  let lastEditItem
  function resumeLastEdit() {
    if (!lastEditItem) return
    let index = indexFromId.get(lastEditItem)
    if (index === undefined) return
    if (index >= hideIndex) {
      alert(`last edited item ${items[index].name} is currently hidden; try going back or revealing more items`)
      return
    }
    if (items[index].editing) return
    editItem(index)
    lastEditorChangeTime = 0 // force immediate update
    onEditorChange(editorText) // since edit state changed
    restoreItemEditor(lastEditItem)
  }

  function textArea(index: number): HTMLTextAreaElement {
    return document.getElementById('textarea-' + (index < 0 ? 'mindbox' : items[index].id)) as HTMLTextAreaElement
  }

  function onPrevItem(inc = -1) {
    if (sessionHistoryIndex > 0 || focusedItem + inc < -1) {
      if (sessionHistoryIndex + 1 < sessionHistory.length) {
        sessionHistoryIndex++
        // console.debug("sessionHistoryIndex", sessionHistoryIndex);
        lastEditorChangeTime = 0 // disable debounce even if editor focused
        onEditorChange(sessionHistory[sessionHistoryIndex])
        tick().then(() => {
          textArea(-1).selectionStart = textArea(-1).selectionEnd = editorText.length
        })
      }
      return
    }
    const index = focusedItem
    if (index + inc == -1) textArea(-1).focus()
    else {
      if (!items[index + inc].editing) {
        if (items[index + inc].pinned) {
          onPrevItem(inc - 1)
          return
        } // skip if pinned
        editItem(index + inc)
      }
      tick().then(() => textArea(index + inc).focus())
    }
  }

  function onNextItem(inc = 1) {
    if (sessionHistoryIndex > 0) {
      sessionHistoryIndex--
      // console.debug("sessionHistoryIndex", sessionHistoryIndex);
      lastEditorChangeTime = 0 // disable debounce even if editor focused
      onEditorChange(sessionHistory[sessionHistoryIndex])
      tick().then(() => {
        const endOfFirstLine = editorText.match(/^[^\n]*/)[0].length
        textArea(-1).selectionStart = textArea(-1).selectionEnd = endOfFirstLine
      })
      return
    }
    if (focusedItem + inc >= Math.min(hideIndex, items.length)) return
    const index = focusedItem
    if (!items[index + inc].editing) {
      if (items[index + inc].pinned || items[index + inc].saving || items[index + inc].running) {
        onNextItem(inc + 1)
        return
      } // skip if pinned, saving, or running
      editItem(index + inc)
    }
    tick().then(() => textArea(index + inc).focus())
  }

  let lastScrollTime = 0
  let historyUpdatePending = false
  function onScroll() {
    // trigger focus on any fresh scrolling
    // in particular for mouse/trackpad input not detected via touchstart/mousedown/keydown
    // we ignore scroll events within 1s of window resize (found problematic on android but generally sensible)
    // does not appear to be possible to shift-focus-on-scroll on macos
    if (Date.now() - lastScrollTime > 250 && Date.now() - lastResizeTime > 1000) focus()
    lastScrollTime = Date.now()
    if (!historyUpdatePending) {
      historyUpdatePending = true
      setTimeout(() => {
        // console.debug("updating history.state.scrollPosition", document.body.scrollTop);
        history.replaceState(Object.assign(history.state, { scrollPosition: document.body.scrollTop }), editorText)
        historyUpdatePending = false
      }, 250)
    }
  }

  let lastResizeTime = 0
  function onResize() {
    lastResizeTime = Date.now()
  }

  function onStatusClick(e) {
    // ignore click if text is selected
    if (window.getSelection().type == 'Range') {
      e.stopPropagation()
      return
    }
    e.stopPropagation()
    if (showDotted && editingItems.some(index => items[index].dotted)) {
      alert('can not minimize items while editing')
      return
    }
    showDotted = !showDotted
  }

  let summarydiv
  function onConsoleClick(e) {
    // ignore click if text is selected
    if (window.getSelection().type == 'Range') {
      e.stopPropagation()
      return
    }
    e.stopPropagation()
    consolediv.style.display = 'none'
    summarydiv.style.visibility = 'visible'
  }
  function onConsoleSummaryClick(e) {
    if (consolediv.childNodes.length > 0) {
      e.stopPropagation()
      consolediv.style.display = 'block'
      summarydiv.style.visibility = 'hidden'
    }
  }

  function errorMessage(e) {
    if (!e) return undefined
    // Some client libraries (e.g. Google API JS client) return an embedded 'error' property, which can itself be a non-standard object with various details (e.g. HTTP error code, message, details, etc), so we just stringify the whole object to provide the most information possible.
    if (!e.message && e.error) return JSON.stringify(e)
    // NOTE: for UnhandledPromiseRejection, Event object is placed in e.reason
    // NOTE: we log url for "error" Events that do not have message/reason
    //       (see https://www.w3schools.com/jsref/event_onerror.asp)
    if (!e.message && (e.type == 'error' || (e.reason && e.reason.type == 'error'))) {
      if (e.reason) e = e.reason
      let url = e.target && (e.target['url'] || e.target['src']) ? e.target['url'] || e.target['src'] : '(unknown url)'
      return `error loading ${url}`
    }
    return e.reason
      ? `Unhandled Rejection: ${e.reason} (line:${e.reason.line}, col:${e.reason.column})`
      : e.message
      ? e.lineno
        ? `${e.message} (line:${e.lineno}, col:${e.colno})`
        : e.line
        ? `${e.message} (line:${e.line}, col:${e.column})`
        : e.stack // all we seem to have is a trace, so let's dump that ...
        ? `${e.message}; STACK: ${e.stack.split(/\n\s*/g).join(', ')}`
        : e.message
      : undefined
  }

  function encryptionError(e) {
    console.error('encryption/decryption failed', e)
    if (signingOut) return // already signing out
    signingOut = true // no other option at this point
    if (e.message.includes('cancelled')) {
      signOut()
      return
    }
    // dispatch in case error is triggered before modal is created
    modal.show({
      content:
        'Unable to access your account. Secret phrase may be incorrect, or your browser may not fully support modern encryption features. Try entering your phrase again or using a different browser. If the problem persists, email support@mind.page with your browser and device information. <i>Do not include your secret phrase, which you should never share with anyone.</i>',
      confirm: 'Sign Out',
      background: 'confirm',
      onConfirm: signOut,
    })
  }

  import { onMount } from 'svelte'
  import {
    hashCode,
    numberWithCommas,
    extractBlock,
    blockRegExp,
    parseTags,
    parseLabel,
    renderTag,
    invalidateElemCache,
    checkElemCache,
    decodeBase64,
  } from '../util.js'

  let consoleLog = []
  const consoleLogMaxSize = 10000
  const statusLogExpiration = 15000

  let itemInitTime = 0
  function initItems() {
    if (itemInitTime) return // already initialized items
    itemInitTime = Date.now()
    items.forEach(item => {
      if (!item.init) return
      try {
        _item(item.id).eval("if (typeof _init == 'function') _init()", {
          // if item has js_init block, use that, otherwise use js block without dependencies
          type: extractBlock(item.text, 'js_init') ? 'js_init' : 'js',
          include_deps: false,
          trigger: 'init',
        })
      } catch (e) {} // already logged, just continue init
    })
  }

  let initTime = 0 // set where initialize is invoked
  let processed = false
  let initialized = false
  let maxRenderedAtInit = 100
  let adminItems = new Set(['QbtH06q6y6GY4ONPzq8N' /* welcome item */])
  let hiddenItems = new Map()
  let hiddenItemsByName = new Map()
  let hiddenItemsInvalid = []
  let resolve_init // set below
  function init_log(...args) {
    console.debug(`[${Math.round(performance.now())}ms] ${args.join(' ')}`)
  }

  // function to initialize new item state to serve as central listing
  function initItemState(item, index, state = {}) {
    // state used in onEditorChange
    if (!item.attr) item.attr = null // default to null for older items missing attr
    item.editable = item.attr?.editable ?? true
    item.source = item.attr?.source ?? null
    item.pushable = false
    item.editing = false // otherwise undefined till rendered/bound to svelte object
    item.matching = false
    item.target = false
    item.target_context = false
    item.tagMatches = 0
    item.labelMatch = false
    item.prefixMatch = false
    item.pinnedMatch = false
    item.pinnedMatchTerm = ''
    item.uniqueLabel = ''
    // item.uniqueLabelPrefixes = [];
    item.matchingTerms = []
    item.matchingTermsSecondary = []
    item.missingTags = []
    item.hasError = false
    // state from updateItemLayout
    item.index = index
    item.lastIndex = index
    item.aboveTheFold = false
    // item.prominence = 0;
    item.leader = false
    item.mover = false
    item.timeString = ''
    item.timeOutOfOrder = false
    item.height = 0
    item.resolve_render = null // invoked from onItemResized on first call
    item.column = 0
    item.lastColumn = 0
    item.nextColumn = -1
    item.nextItemInColumn = -1
    item.outerHeight = 0
    // dependents (filled below)
    item.dependents = []
    item.dependentsString = ''
    // other state
    item.lastEvalTime = 0 // used for _item.get_log
    item.lastRunTime = 0 // used for _item.get_log
    item.version = 0
    return _.merge(item, state)
  }

  async function initialize() {
    // decrypt any encrypted items
    items = (await Promise.all(items.map(decryptItem)).catch(encryptionError)) || []
    if (signingOut) return // encryption error

    // filter "admin" items (e.g. welcome item) on readonly account
    if (readonly) items = items.filter(item => !adminItems.has(item.id))

    // filter "hidden" items used for encrypted synced storage
    // also move into hiddenItems map for easy access later
    // warn about hidden items on anonymous account
    const existing_ids = new Set<string>() // ids for global_store cleanup
    items.forEach(item => {
      if (!item.hidden) existing_ids.add(item.id)
    })
    items.forEach(item => {
      if (item.hidden) {
        const wrapper = Object.assign(JSON.parse(item.text), { id: item.id })
        // console.debug("found hidden item", wrapper.name, wrapper.name, wrapper.id, wrapper);
        // mark duplicate as invalid
        if (hiddenItemsByName.has(wrapper.name)) {
          console.warn('found invalid hidden item under duplicate name', wrapper.name, wrapper.id, wrapper)
          hiddenItemsInvalid.push(wrapper)
          return
        }
        // mark any hidden item on anonymous account as invalid
        if (anonymous) {
          console.warn('found invalid hidden item on anonymous account', wrapper.name, wrapper.id, wrapper)
          hiddenItemsInvalid.push(wrapper)
          return
        }
        // mark any global_store_<id> hidden item associated with a missing/deleted <id> as invalid
        if (wrapper.name.match(/^global_store_/)) {
          const id = wrapper.name.replace(/^global_store_/, '')
          if (!existing_ids.has(id)) {
            console.warn(
              'found invalid hidden global_store_* item associated with missing/deleted item',
              wrapper.name,
              wrapper.id,
              wrapper
            )
            hiddenItemsInvalid.push(wrapper)
            return
          }
        }
        hiddenItems.set(wrapper.id, wrapper)
        hiddenItemsByName.set(wrapper.name, wrapper)
      }
    })
    items = items.filter(item => !item.hidden)

    indexFromId = new Map<string, number>() // needed for initial itemTextChanged
    items.forEach((item, index) => indexFromId.set(item.id, index))
    items.forEach((item, index) => {
      itemTextChanged(index, item.text, false /*update_deps*/) // deps handled below after index assignment
      initItemState(item, index)
      item.admin = adminItems.has(item.id)
      item.savedId = item.id
      item.savedTime = item.time
      item.savedAttr = _.cloneDeep(item.attr)
      item.savedText = item.text
    })
    finalizeStateOnEditorChange = true // make initial empty state final
    onEditorChange('') // initial sorting
    items.forEach((item, index) => {
      // initialize deps, deephash, missing tags/labels
      item.deps = itemDeps(index)
      item.deephash = hashCode(
        item.deps
          .map(id => items[indexFromId.get(id)].hash)
          .concat(item.hash)
          .join()
      )
      item.deepasync = item.async || item.deps.some(id => items[indexFromId.get(id)].async)
      item.deps.forEach(id => items[indexFromId.get(id)].dependents.push(item.id))
    })
    items.forEach(item => {
      item.depsString = itemDepsString(item)
      item.dependentsString = itemDependentsString(item)
    })

    initItems()

    // if fragment corresponds to an item tag or id, focus on that item immediately ...
    if (items.length > 0 && location.href.match(/#.+$/)) {
      const tag = decodeURI(location.href.match(/#.+$/)[0])
      // if it is a valid item id, then we convert it to name
      const index = indexFromId.get(tag.substring(1))
      if (index !== undefined) {
        replaceStateOnEditorChange = true // replace state
        lastEditorChangeTime = 0 // disable debounce even if editor focused
        onEditorChange(items[index].name)
      } else if (idsFromLabel.get(tag.toLowerCase())?.length == 1) {
        replaceStateOnEditorChange = true // replace state
        lastEditorChangeTime = 0 // disable debounce even if editor focused
        onEditorChange(tag)
      }
    }

    processed = true
    // init_log(`processed ${items.length} items`);

    // NOTE: last step in initialization is rendering, which is handled asynchronously by svelte and considered completed when onItemResized is invoked for each item (zero heights are logged as warning); we support initialization in chunks, but it seems background rendering can make rendered items unresponsive (even if done in small chunks with large intervals), so best option may be to have a hard truncation point to limit initialization time -- the downside of uninitialized items is that their heights are not known until they are rendered

    const unpinnedIndex = _.findLastIndex(items, item => item.pinned) + 1
    await renderRange(
      0,
      unpinnedIndex /*initial chunk*/,
      10 /*chunk*/,
      Math.min(maxRenderedAtInit, items.length) /*cutoff*/,
      100 /*delay*/
    ).then(() => {
      init_log(`initialized ${items.length} items`)
      initialized = true
      resolve_init()
    })
  }

  let rendered = false
  let renderStart = 0
  let renderEnd = 0
  let keepOnPageDuringDelay = false

  function renderRange(start, end, chunk, cutoff, delay) {
    renderStart = start
    renderEnd = Math.min(cutoff, end)
    return Promise.all(
      items.slice(renderStart, renderEnd).map(
        item =>
          new Promise(resolve => {
            if (item.height > 0) resolve(item.height)
            else item.resolve_render = resolve // resolve later in onItemResized
          })
      )
    ).then(() => {
      if (!keepOnPageDuringDelay) renderStart = renderEnd
      if (renderEnd < cutoff) {
        // init_log(`rendered items ${renderStart}-${renderEnd}`);
        if (start == 0 || Math.floor(start / 100) < Math.floor(renderEnd / 100))
          init_log(`rendered ${renderEnd}/${items.length} items (limit ${cutoff})`)
        tick().then(() => setTimeout(() => renderRange(renderEnd, renderEnd + chunk, chunk, cutoff, delay), delay))
      } else {
        init_log(`rendered ${cutoff}/${items.length} items (limit ${cutoff})`)
        rendered = true
      }
    })
  }

  let signingIn = false
  function signIn() {
    // if user appears to be signed in, sign out instead
    if (firebase().auth().currentUser) {
      if (!signedin) alert('inconsistent signin state, signing out ...')
      console.warn('attempted to sign in while already signed in, signing out ...')
      signOut()
      return
    }
    signingIn = true

    // blur active element as caret can show through loading div
    // (can require dispatch on chrome if triggered from active element)
    setTimeout(() => (document.activeElement as HTMLElement).blur())

    resetUser()
    window.sessionStorage.setItem('mindpage_signin_pending', '1') // prevents anonymous user on reload
    document.cookie = '__session=signin_pending;max-age=600' // temporary setting for server post-redirect
    let provider = new window['firebase'].auth.GoogleAuthProvider()
    firebase().auth().useDeviceLanguage()
    // firebase().auth().setPersistence("none")
    // firebase().auth().setPersistence("session")
    firebase().auth().setPersistence('local')
    // NOTE: Both redirect and popup-based login methods work in most cases. Android can fail to login with redirects (perhaps getRedirectResult could work better although should be redundant given onAuthStateChanged) but works ok with popup. iOS looks better with redirect, and firebase docs (https://firebase.google.com/docs/auth/web/google-signin) say redirect is preferred on mobile. Indeed popup feels better on desktop, even though it also requires a reload for now (much easier and cleaner than changing all user/item state). So we currently use popup login except on iOS, where we use a redirect for cleaner same-tab flow.
    // if (!android()) firebase().auth().signInWithRedirect(provider);
    if (ios) firebase().auth().signInWithRedirect(provider)
    else {
      firebase()
        .auth()
        .signInWithPopup(provider)
        .then(() => location.reload())
        .catch(console.error)
    }
  }

  function isAdmin() {
    return (
      user?.uid == 'y2swh7JY2ScO5soV7mJMHVltAOX2' &&
      (location.host == 'mindbox.io' || location.href.match(/user=(?:anonymous|admin)/) != null)
    )
  }

  function useAnonymousAccount() {
    user = {
      photoURL: '/incognito.png',
      displayName: 'Anonymous',
      uid: 'anonymous',
    }
    secret = null // should never be needed under anonymous account
    anonymous = true
    // anonymous account should not have a server cookie (even if admin)
    document.cookie = '__session=;max-age=0'
  }

  let initialization
  if (isClient)
    initialization = new Promise(resolve => {
      resolve_init = resolve // invoked from initialize()

      // set up replay log until .console is set up in onMount
      let replay_log = []
      log_levels.forEach(verb => {
        console['_' + verb] = console[verb]
        console[verb] = (...args) => {
          replay_log.push({ verb, args, stack: evalStack.slice() })
          return console['_' + verb](...args)
        }
      })

      // NOTE: We simply log the server side error as a warning. Currently only possible error is "invalid session cookie" (see session.ts), and assuming items are not returned/initialized below, firebase realtime should be able to initialize items without requiring a page reload, which is why this can be just a warning.
      if (error) console.warn(error) // log server-side error

      // pre-fetch user from localStorage instead of waiting for onAuthStateChanged
      // (seems to be much faster to render user.photoURL, but watch out for possible 403 on user.photoURL)
      if (!user && localStorage.getItem('mindpage_user')) {
        user = JSON.parse(localStorage.getItem('mindpage_user'))
        secret = localStorage.getItem('mindpage_secret') // may be null if user was acting as anonymous
        init_log(`restored user ${user.email}`)
      } else if (window.sessionStorage.getItem('mindpage_signin_pending')) {
        init_log('resuming signin ...')
        window.sessionStorage.removeItem('mindpage_signin_pending') // no longer considered pending
        user = secret = null
      } else {
        useAnonymousAccount()
      }
      admin = isAdmin()
      if (admin) useAnonymousAccount() // become anonymous for item checks below
      anonymous = user?.uid == 'anonymous'
      readonly = anonymous && !admin

      // print client load time w/ preloaded item count, excluding admin and hidden items
      const preload_count = _.sumBy(items_preload, ({ hidden, id }) =>
        !hidden && (!readonly || !adminItems.has(id)) ? 1 : 0
      )
      console.debug(
        `[${window['_client_start_time']}ms] loaded client` + (preload_count > 0 ? ` + ${preload_count} items` : '')
      )

      // if items were returned from server, confirm user, then initialize if valid
      if (items_preload.length > 0) {
        items = items_preload
        if (window.sessionStorage.getItem('mindpage_signin_pending')) {
          console.warn(`ignoring ${items.length} items during signin`)
          items = []
        } else if (user && user.uid != items[0].user) {
          // items are for wrong user, usually anonymous, due to missing/expired cookie
          // you can test this with document.cookie='__session=;max-age=0' in console
          // can also happen when admin is logged in but acting as anonymous
          // NOTE: we now refresh session cookie regularly and do not expect this warning
          // if (items[0].user != "anonymous")
          console.warn(`ignoring ${items.length} items (${items[0].user})`)
          items = []
        } else {
          // NOTE: at this point item heights (and totalItemHeight) will be zero and the loading indicator stays, but we need the items on the page to compute their heights, which will trigger updated layout through onItemResized
          initTime = window['_init_time'] = Date.now() // indicate initialization started
          initialize()
        }
      }

      // NOTE: we do not attempt login for readonly account (if login hangs, this is suspect)
      if (!readonly) {
        // if initializing items, wait for that before signing in user since errors can trigger signout
        Promise.resolve(initialization).then(() => {
          firebase()
            .auth()
            .onAuthStateChanged(authUser => {
              // console.debug("onAuthStateChanged", user, authUser);
              if (readonly) {
                console.warn('ignoring unexpected signin')
                return
              }
              if (!authUser) {
                if (anonymous) return // anonymous user can be signed in or out
                console.error('failed to sign in') // can happen in chrome for localhost, and on android occasionally
                document.cookie = '__session=;max-age=0' // delete cookie to prevent preload on reload
                return
              }
              resetUser() // clean up first
              user = authUser
              init_log('signed in', user.email)
              localStorage.setItem('mindpage_user', JSON.stringify(user))
              anonymous = readonly = false // just in case (should already be false)
              signedin = true

              // NOTE: olcans@gmail.com signed in as "admin" will ACT as anonymous account
              //       (this is the only case where user != firebase().auth().currentUser)
              admin = isAdmin()
              if (admin) {
                useAnonymousAccount()
              } else {
                // set up server-side session cookie
                // maximum max-age seems to be 7 days for Safari & we refresh daily
                // store user's ID token as a __session cookie to send to server for preload
                // __session is the only cookie allowed by firebase for efficient caching
                // (see https://stackoverflow.com/a/44935288)
                const sessionCookieMaxAge = 7 * 24 * 60 * 60 // 7 days
                function updateSessionCookie() {
                  user
                    .getIdToken(false /*force refresh*/)
                    .then(token => {
                      // console.debug("updating session cookie, max-age ", sessionCookieMaxAge);
                      document.cookie = '__session=' + token + ';max-age=' + sessionCookieMaxAge
                    })
                    .catch(console.error)
                }
                updateSessionCookie()
                setInterval(updateSessionCookie, 1000 * 24 * 60 * 60)
              }

              initFirebaseRealtime()
            })
        })
      } else if (anonymous && items_preload.length == 0) {
        initFirebaseRealtime() // synchronize anonymous items using firebase realtime
      }

      // Visual viewport resize/scroll handlers ...
      let lastDocumentWidth = 0
      let lastWindowHeight = 0
      let lastFocusElem = null // element that had focus on last recorded width/height
      function checkLayout() {
        // on android, if window height grows enough, assume keyboard is closed and blur active element
        // (otherwise e.g. tapping of tags with editor focused will scroll back up)
        if (android && outerHeight > lastWindowHeight + 200) (document.activeElement as HTMLElement).blur()

        if (Date.now() - lastScrollTime < 250) return // avoid layout during scroll
        if (Date.now() - lastResizeTime < 250) return // avoid layout during resizing

        // update vertical padding, but only if we are consistently unfocused (to avoid shifting during/after focus)
        if (
          (!document.activeElement || document.activeElement.isSameNode(document.body)) &&
          document.activeElement == lastFocusElem
        )
          updateVerticalPadding()

        const documentWidth = getDocumentWidth()
        if (
          documentWidth != lastDocumentWidth ||
          // ignore height change if active element also changed
          // (to avoid responding to temporary virtual keyboards)
          (outerHeight != lastWindowHeight && document.activeElement.isSameNode(lastFocusElem))
        ) {
          updateItemLayout()
          // resize of all elements w/ _resize attribute (and property)
          document.querySelectorAll('[_resize]').forEach(elem => elem['_resize']())
        }

        lastDocumentWidth = documentWidth
        lastWindowHeight = outerHeight
        lastFocusElem = document.activeElement

        // update time strings every 10 seconds
        // NOTE: we do NOT update time string visibility/grouping here, and there can be differences (from layout strings) in both directions (time string hidden while distinct from previous item, or time string shown while identical to previous item) but arguably we may not want to show/hide time strings (and shift items) outside of an actual layout, and time strings should be interpreted as rough (but correct) markers along the timeline, with items grouped between them in correct order and with increments within the same order of unit (m,h,d) implied by last shown time string
        if (Date.now() - lastTimeStringUpdateTime > 10000) {
          lastTimeStringUpdateTime = Date.now()
          items.forEach((item, index) => {
            if (!item.timeString) return
            item.timeString = itemTimeString(item.time)
          })
          items = items // trigger svelte render
        }

        // on ios, fix textarea/editor height if inconsistent with backdrop height
        // was first observed on iOS 15 when switching back to split windows
        // logic is same as in updateTextDivs() in Editor.svelte
        if (ios) {
          document.querySelectorAll('.editor').forEach((editor: HTMLElement) => {
            const textarea = editor.querySelector('textarea')
            const backdrop = editor.querySelector('.backdrop')
            if (editor.style.height != backdrop.scrollHeight + 'px')
              // inconsistent
              textarea.style.height = editor.style.height = backdrop.scrollHeight + 'px'
          })
        }
      }

      document.body.addEventListener('scroll', onScroll)
      visualViewport.addEventListener('resize', onResize)

      let firstSnapshot = true
      function initFirebaseRealtime() {
        if (!user) return // need user.uid

        // start listening for remote changes
        // (also initialize if items were not returned by server)
        let firebase_snapshot_errors = 0
        firebase()
          .firestore()
          .collection('items')
          .where('user', '==', user.uid)
          .orderBy('time', 'desc')
          .onSnapshot(
            function (snapshot) {
              if (window['_disable_sync']) {
                console.warn('ignoring firestore snapshot due to _disable_sync')
                return
              }
              let first_snapshot_items = 0
              let first_snapshot_changes = 0
              snapshot.docChanges().forEach(function (change) {
                const doc = change.doc
                // on first snapshot, if initialization has not started (initTime = 0), we simply append items into an array and then initialize; otherwise we ignore the first snapshot, which is presumably coming from a local cache so that it is cheap and worse than whatever we already got from the server
                if (firstSnapshot) {
                  first_snapshot_changes++
                  if (change.type != 'added') console.warn('unexpected change type: ', change.type)
                  if (!initTime) {
                    first_snapshot_items++
                    // NOTE: snapshot items do not have updateTime/createTime available
                    items.push(Object.assign(doc.data(), { id: doc.id }))
                  }
                  return
                }
                if (doc.metadata.hasPendingWrites) return // ignore local change
                decryptItem(doc.data()).then(savedItem => {
                  // remote changes indicate non-focus: update sessionTime and invoke onFocus
                  sessionTime = Date.now() + 1000 /* margin for small time differences */
                  onFocus() // focused = window.hasFocus

                  // console.debug("detected remote change:", change.type, doc.id);
                  if (change.type === 'added') {
                    if (savedItem.hidden) {
                      const wrapper = Object.assign(JSON.parse(savedItem.text), { id: doc.id })
                      hiddenItems.set(wrapper.id, wrapper)
                      if (hiddenItemsByName.has(wrapper.name))
                        console.warn('remote-added hidden item name exists locally', wrapper.name)
                      hiddenItemsByName.set(wrapper.name, wrapper)
                      hiddenItemChangedRemotely(wrapper.name, change.type)
                      return
                    }
                    // NOTE: remote add is similar to onEditorDone without js, saving, etc
                    let item = initItemState({}, 0, {
                      ...savedItem,
                      id: doc.id,
                      savedId: doc.id,
                      savedTime: savedItem.time,
                      savedAttr: _.cloneDeep(savedItem.attr),
                      savedText: savedItem.text,
                    })
                    items = [item, ...items]
                    // update indices as needed by itemTextChanged
                    items.forEach((item, index) => indexFromId.set(item.id, index))
                    itemTextChanged(
                      0,
                      item.text,
                      true /* update_deps */,
                      false /* run_deps */,
                      false /* keep_time */,
                      true /* remote */
                    )
                    lastEditorChangeTime = 0 // disable debounce even if editor focused
                    // hideIndex++; // show one more item (skip this for remote add)
                    onEditorChange(editorText) // integrate new item at index 0
                  } else if (change.type == 'removed') {
                    if (savedItem.hidden) {
                      const wrapper = hiddenItems.get(doc.id)
                      if (!wrapper) {
                        // NOTE: hasPendingWrites can be false for local deletes, see https://stackoverflow.com/q/54884508
                        // console.warn("remote-deleted hidden item missing locally", doc.id);
                        return
                      }
                      hiddenItems.delete(wrapper.id)
                      hiddenItemsByName.delete(wrapper.name)
                      hiddenItemChangedRemotely(wrapper.name, change.type)
                      return
                    }
                    // NOTE: remote remove is similar to deleteItem
                    // NOTE: document may be under temporary id if it was added locally
                    let index = indexFromId.get(tempIdFromSavedId.get(doc.id) || doc.id)
                    if (index === undefined) return // nothing to remove
                    let item = items[index]
                    itemTextChanged(
                      index,
                      '',
                      true /* update_deps */,
                      false /* run_deps */,
                      false /* keep_time */,
                      true /* remote */
                    )
                    items.splice(index, 1)
                    if (index < hideIndex) hideIndex-- // back up hide index
                    // update indices as needed by onEditorChange
                    indexFromId = new Map<string, number>()
                    items.forEach((item, index) => indexFromId.set(item.id, index))
                    lastEditorChangeTime = 0 // disable debounce even if editor focused
                    onEditorChange(editorText) // deletion can affect ordering (e.g. due to missingTags)
                    deletedItems.unshift({
                      time: item.savedTime,
                      attr: _.cloneDeep(item.savedAttr),
                      text: item.savedText,
                    }) // for /undelete
                  } else if (change.type == 'modified') {
                    if (savedItem.hidden) {
                      const wrapper = Object.assign(JSON.parse(savedItem.text), { id: doc.id })
                      if (!hiddenItems.has(wrapper.id))
                        console.warn('remote-modified hidden item missing locally', wrapper.id)
                      else if (hiddenItems.get(wrapper.id).name != wrapper.name)
                        console.warn(
                          'remote-modified hidden item has different name',
                          wrapper.name,
                          hiddenItems.get(wrapper.id).name
                        )
                      hiddenItems.set(wrapper.id, wrapper)
                      hiddenItemsByName.set(wrapper.name, wrapper)
                      hiddenItemChangedRemotely(wrapper.name, change.type)
                      return
                    }
                    // NOTE: remote modify is similar to _write without saving
                    // NOTE: document may be under temporary id if it was added locally
                    let index = indexFromId.get(tempIdFromSavedId.get(doc.id) || doc.id)
                    if (index === undefined) return // nothing to modify
                    let item = items[index]
                    item.time = item.savedTime = savedItem.time
                    item.text = item.savedText = savedItem.text
                    item.attr = savedItem.attr
                    item.savedAttr = _.cloneDeep(item.attr)
                    itemTextChanged(
                      index,
                      item.text,
                      true /* update_deps */,
                      false /* run_deps */,
                      true /* keep_time */,
                      true /* remote */
                    )
                    lastEditorChangeTime = 0 // disable debounce even if editor focused
                    onEditorChange(editorText) // item time/text has changed
                  }
                })
              }) // snapshot.docChanges().forEach

              // if this is first snapshot and initialization has not started (initTime = 0), start it now
              // either way set up callback to complete "synchronization" and set up welcome item if needed
              if (firstSnapshot) {
                if (!initTime) {
                  // alert on empty init for user known to have items, or on any errors before/during first snapshot
                  // TODO: remove this once you've debugged the issue where first snapshot is blank and items are added in subsequent snapshot(s), triggering the "welcome" dialog and many errors as items are added incrementally (and slowly) post-initialization ... if there are no relevant error/warnings and no other ways to detect a problem, then we may have to either track total number of items, or new users w/ empty accounts, or both.
                  if (first_snapshot_items == 0 && user.uid == 'y2swh7JY2ScO5soV7mJMHVltAOX2') {
                    alert(
                      `failed init w/ zero items for non-empty account; changes: ${first_snapshot_changes} (see warnings for types), errors: ${firebase_snapshot_errors}; see console for details, reload to retry`
                    )
                  } else if (firebase_snapshot_errors > 0) {
                    alert(`failed init w/ ${firebase_snapshot_errors} errors; see console for details, reload to retry`)
                  } else {
                    initTime = window['_init_time'] = Date.now()
                    initialize()
                  }
                }
                Promise.resolve(initialization).then(() => {
                  if (!initialized) return // initialization failed, we should be signing out ...
                  init_log(`synchronized ${items.length} items`)
                  firstSnapshot = false

                  // if account is empty, copy the welcome item from the anonymous account, which should also trigger a request for the secret phrase in order to encrypt the new welcome item
                  if (items.length == 0) onEditorDone('/_welcome')

                  // if necessary, init secret by triggering a test encryption/decryption
                  if (!secret) {
                    const hello_item = { user: user.uid, time: Date.now(), text: 'hello' }
                    encryptItem(hello_item)
                      .then(decryptItem)
                      .then(item => {
                        if (JSON.stringify(item) != JSON.stringify(hello_item))
                          throw new Error('encryption test failed')
                      })
                      .catch(encryptionError)
                  }

                  // delete invalid hidden items after initialization
                  // TODO: ensure no duplication issue after empty initialization issue is fixed
                  hiddenItemsInvalid.forEach(wrapper => {
                    console.warn('deleting invalid hidden item', wrapper.name, wrapper.id, wrapper)
                    deleteHiddenItem(wrapper.id)
                  })
                })
              }
            },
            error => {
              firebase_snapshot_errors++
              console.error(error)
              if (error.code == 'permission-denied') {
                // NOTE: server (admin) can still preload items if user account was deactivated with encrypted items
                //       (this triggers a prompt for secret phrase on reload, but can be prevented by clearing cookie)
                document.cookie = '__session=;max-age=0' // delete cookie to prevent preload on reload
                signingOut = true // no other option at this point
                modal.show({
                  content: `Welcome ${window['_user'].name}! Your personal account requires activation. Please email support@mind.page from ${user.email} and include account identifier \`${user.uid}\` in the email.`,
                  confirm: 'Sign Out',
                  background: 'confirm',
                  onConfirm: signOut,
                })
              }
            }
          )
      }

      onMount(() => {
        Promise.resolve(initialization).then(() => {
          focus() // focus on init (focus and checkFocus are disabled until init)

          let replay = true // true until replay below
          log_levels.forEach(function (verb) {
            console[verb] = function (...args) {
              // NOTE: we indicate full eval stack as prefix
              let prefix = evalStack
                .map(id => items[indexFromId.get(id)].name)
                .filter((n, j, nJ) => n != nJ[j - 1]) // remove consecutive duplicates
                .join(' ')
              if (prefix) prefix = '[' + prefix + '] '
              if (!replay) {
                if (prefix) console['_' + verb](prefix, ...args)
                else console['_' + verb](...args)
              }
              if (!consolediv) {
                console['_warn']('consolediv not ready')
                return
              }
              var elem = document.createElement('div')
              if (verb.endsWith('error')) verb = 'error'
              elem.classList.add('console-' + verb)
              let text = ''
              if (args.length == 1 && errorMessage(args[0])) text = errorMessage(args[0])
              else text = args.join(' ') + '\n'
              elem.textContent = prefix + text
              elem.setAttribute('_time', Date.now().toString())
              elem.setAttribute('_level', log_levels.indexOf(verb).toString())
              consolediv.appendChild(elem)
              consoleLog.push({
                type: verb,
                stack: evalStack.slice(),
                // disallow multi-line log messages to simplify handling, e.g. using TYPE: prefix
                text: text.replace(/\s*\n+\s*/g, ' ').trim(),
                time: Date.now(),
                level: log_levels.indexOf(verb),
              })
              if (consoleLog.length > consoleLogMaxSize) consoleLog = consoleLog.slice(consoleLogMaxSize / 2)

              const summaryelem = document.createElement('span')
              summaryelem.innerText = '·'
              summaryelem.classList.add('console-' + verb)
              summarydiv.appendChild(summaryelem)

              // if console is hidden, make sure summary is visible and clickable
              if (consolediv.style.display == 'none') {
                summarydiv.style.visibility = 'visible'
                summarydiv.style.cursor = 'pointer'
              }

              // auto-remove after 15 seconds ...
              setTimeout(() => {
                elem.remove()
                summaryelem.remove()
                if (!consolediv) return
                if (consolediv.childNodes.length == 0) {
                  consolediv.style.display = 'none'
                  summarydiv.style.visibility = 'visible'
                  summarydiv.style.cursor = 'auto'
                }
              }, statusLogExpiration)
            }
          })
          // replay logs during init (including eval stack)
          const _evalStack = evalStack // restored post-replay
          replay_log.forEach(entry => {
            evalStack = entry.stack
            console[entry.verb](...entry.args)
          })
          evalStack = _evalStack
          replay = false
        })

        window.onstorage = () => {
          onStorageFired = true // receiving onstorage events from other instances of app
          // NOTE: we only check localStorage for properties we want to sync dynamically (across tabs on same device)
          if (zoom != localStorage.getItem('mindpage_zoom')) {
            zoom = localStorage.getItem('mindpage_zoom')
            checkLayout() // check layout for remote zoom change
          }
          checkFocus()
        }
        setInterval(checkLayout, 250) // check layout every 250ms
        setInterval(checkElemCache, 1000) // check elem cache every second

        // // check service workers
        // if (navigator.serviceWorker) {
        //   navigator.serviceWorker.getRegistrations().then(function (registrations) {
        //     for (let registration of registrations)
        //       console.debug("service worker found for scope: " + registration.scope);
        //   });
        // } else {
        //   console.debug("service workers not available");
        // }

        let welcome = null
        if (readonly) {
          welcome = modal.show({
            content:
              'Welcome to MindPage! This is an **anonymous demo account**. Your edits will be discarded when you close (or reload) this page, and are _never sent or stored anywhere_.',
            // content: `Welcome ${window["_user"].name}! Your personal account requires activation. Please email support@mind.page from ${user.email} and include account identifier \`${user.uid}\` in the email.`,
            confirm: 'Stay Anonymous',
            cancel: 'Sign In',
            onCancel: signIn,
            background: 'confirm',
          })
        }

        // evaluate _on_welcome items once initialization is done, welcome dialog is dismissed, dom is fully updated
        Promise.all([initialization, welcome])
          .then(update_dom)
          .then(() => {
            items.forEach(item => {
              if (!item.welcome) return
              try {
                _item(item.id).eval("if (typeof _on_welcome == 'function') _on_welcome()", { trigger: 'welcome' })
              } catch (e) {} // already logged, just continue welcome eval
            })
          })

        init_log('initialized document')
      })

      init_log('initialized client')
    })

  function onColumnPaddingMouseDown(e) {
    e.preventDefault() // prevent click & focus shift
    document.body.scrollTo(0, headerdiv.offsetTop)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!e.metaKey) focus() // focus on keydown, except when cmd-modified, e.g. for cmd-tilde
    const key = e.code || e.key // for android compatibility
    if (!key) return // can be empty for pencil input on ios
    // console.debug("window.onKeyDown:", e, key);

    const modified = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey

    // console.debug(e, initialized, modal.isVisible());
    if (!initialized) return
    if (modal.isVisible()) return

    // disable arrow keys to prevent ambiguous behavior
    if (key.startsWith('Arrow')) e.preventDefault()

    // disable space bar page-scroll behavior
    if (key == 'Space') e.preventDefault()

    // left Shift+ArrowDown/ArrowUp toggle items
    if ((key == 'ArrowDown' || key == 'ArrowUp') && e.shiftKey) {
      const toggle =
        key == 'ArrowDown' ? document.querySelector(`.toggle.show`) : _.last(document.querySelectorAll(`.toggle.hide`))
      if (toggle) {
        // if toggle is too far down, bring it to ~upper-middle of page, snapping to header
        const toggleTop = (toggle as HTMLElement).offsetTop
        if (toggleTop > document.body.scrollTop + innerHeight - 200)
          document.body.scrollTo(0, Math.max(headerdiv.offsetTop, toggleTop - innerHeight / 4))
        toggle.dispatchEvent(new Event('click'))
      }
      return
    }

    // let unmodified DigitX select/target corresponding item if named, touch it otherwise
    // let Digit0 scroll target to ~center, or scroll to top if no target
    if (key.match(/Digit\d+/) && !modified) {
      const index = parseInt(key.match(/\d+/)?.shift()) - 1
      if (index == -1) {
        const target = document.querySelector(`.super-container.target`) as HTMLElement
        if (target) document.body.scrollTo(0, target.offsetTop - innerHeight / 4)
        else document.body.scrollTo(0, headerdiv.offsetTop) // just scroll to top
        return
      }
      const item = items[index]
      if (item?.uniqueLabel) {
        const target = document.querySelector(`#super-container-${item.id} .container`)
        if (target) {
          target.querySelector('mark.label')?.dispatchEvent(new MouseEvent('mousedown'))
          // target.dispatchEvent(new Event("mousedown"));
          // target.dispatchEvent(new Event("click"));
        } else {
          alert(`item numbered ${index + 1} (${item.name}) is not visible`)
        }
      } else if (item) {
        _item(item.id).touch()
      }
      return
    }

    // let unmodified Enter to edit target OR resume last edit
    const target = document.querySelector('.container.target')
    if (key == 'Enter' && !modified) {
      e.preventDefault() // prevent entry into item editor
      // edit click requires mousedown first (see onClick in Item.svelte)
      if (target && target.getAttribute('item-id') != lastEditItem) {
        target.dispatchEvent(new Event('mousedown'))
        target.dispatchEvent(new Event('click'))
      } else if (lastEditItem && indexFromId.get(lastEditItem) < hideIndex) {
        resumeLastEdit()
      } else {
        // try editing first unpinned item OR toggling it visible
        const targetId = items.find(item => !item.pinned)?.id
        if (targetId) {
          const target = document.querySelector(`#super-container-${targetId} .container`)
          if (target) {
            target.dispatchEvent(new Event('mousedown'))
            target.dispatchEvent(new Event('click'))
          } else {
            document.querySelector(`.toggle.show`)?.dispatchEvent(new Event('click'))
          }
        }
      }
      return
    }
    // let unmodified Backquote run target item
    if (key == 'Backquote' && !modified && target) {
      target.querySelector('.run')?.dispatchEvent(new Event('click'))
      return
    }
    // let Shift+Backquote toggle logs on target item
    if (key == 'Backquote' && e.shiftKey && target) {
      target.querySelector('.log-summary')?.dispatchEvent(new Event('click'))
      return
    }
    // let unmodified ArrowLeft/Right select next/prev visible non-label tag in last context item
    if ((key == 'ArrowLeft' || key == 'ArrowRight') && !modified) {
      // pick "most recently interacted context that contains selected tag"; this is usually the parent context immediately above target but does not have to be, and this approach keeps the prev/next navigation context stable while still allowing additional context to appear below/above and also allowing switching navigation context by interacting with those other context items if desired
      const lastContext = Array.from(document.querySelectorAll('.container.target_context'))
        .filter(e => e.querySelector('mark.selected'))
        .sort((a, b) => item(b.getAttribute('item-id')).time - item(a.getAttribute('item-id')).time)[0]
      if (lastContext) {
        let visibleTags = Array.from(lastContext.querySelectorAll('mark:not(.hidden,.label,.deps-and-dependents *)'))
        // drop duplicates to avoid ambiguities/cycles
        visibleTags = _.uniqBy(visibleTags, (t: any) => t.title)
        let selectedIndex = visibleTags?.findIndex(e => e.matches('.selected'))
        // if context is based on nesting (vs _context tag) and selected tag is nested under it, then we only navigate among other nested siblings, thus giving preference to nested context navigation over unstructured context navigation which can be much more confusing
        const contextLabel = (lastContext.querySelector('mark.label') as any)?.title
        // context labels can be non-unique, so we have to use item(lastContext.getAttribute("item-id"))
        const contextBasedOnNesting = contextLabel && !item(lastContext.getAttribute('item-id')).context
        if (
          selectedIndex >= 0 &&
          contextBasedOnNesting &&
          visibleTags[selectedIndex]['title']?.startsWith(contextLabel + '/')
        ) {
          const selectedTag = visibleTags[selectedIndex]['title']
          const siblings = visibleTags.filter(t => t['title']?.startsWith(contextLabel + '/'))
          visibleTags = siblings
          selectedIndex = visibleTags.findIndex(e => e.matches('.selected'))
        }
        if (selectedIndex >= 0) {
          if (key == 'ArrowRight' && selectedIndex < visibleTags.length - 1)
            visibleTags[selectedIndex + 1].dispatchEvent(new MouseEvent('mousedown', { altKey: true }))
          else if (key == 'ArrowLeft' && selectedIndex > 0)
            visibleTags[selectedIndex - 1].dispatchEvent(new MouseEvent('mousedown', { altKey: true }))
        }
        return // context exists, so ArrowLeft/Right assumed handled
      }
    }
    // let unmodified ArrowDown (or ArrowRight if not handled above because of missing context) select first visible non-label non-secondary-selected "child" tag in target item; we avoid secondary-selected context tags since we are trying to navigate "down"
    if ((key == 'ArrowDown' || key == 'ArrowRight') && !modified) {
      // target labels are unique by definition, so no ambiguity in _item(label)
      let targetLabel = (document.querySelector('.container.target mark.label') as any)?.title
      let nextTargetId
      if (targetLabel) {
        // we require nested children unless target is marked _context, because otherwise going "down" into non-nested children gets confusing since the target would not appear as context
        let child
        if (item(_item(targetLabel).id).context) {
          // allow arbitrary child tag
          child = document.querySelector(
            '.container.target mark:not(.hidden,.label,.secondary-selected,.deps-and-dependents *)'
          )
        } else {
          // filter to children w/ nested labels
          const childTags = Array.from(
            document.querySelectorAll(
              '.container.target mark:not(.hidden,.label,.secondary-selected,.deps-and-dependents *)'
            )
          ).filter(t => t['title']?.startsWith(targetLabel + '/'))
          child = childTags[0]
        }
        if (child) {
          child.dispatchEvent(new MouseEvent('mousedown', { altKey: true }))
        } else {
          // no child found for target, so search for next non-pinned item w/ unique label; "next" means that the label is not in editorChangesWithTimeKept, which contains all recent tag clicks that do not modify item times (due to altKey:true attribute on the mouse event, see above)
          const targetIndex = item(_item(targetLabel).id).index
          nextTargetId = items.find(
            item =>
              item.index > targetIndex && !item.pinned && item.labelUnique && !editorChangesWithTimeKept.has(item.label)
          )?.id
        }
      } else {
        // select first non-pinned item w/ unique label if clickable
        nextTargetId = items.find(item => !item.pinned && item.labelUnique)?.id
      }
      if (nextTargetId) {
        let nextTarget = document.querySelector(`#super-container-${nextTargetId} mark.label`)
        // if next target is not found, click on next show toggle and try again after dispatch
        // if target is still not found, then we will have at least toggled new items into view
        if (nextTarget) nextTarget.dispatchEvent(new MouseEvent('mousedown', { altKey: true }))
        else {
          const showToggle = document.querySelector(`.toggle.show`)
          if (showToggle) {
            // if toggle is too far down, bring it to ~upper-middle of page, snapping to header
            const toggleTop = (showToggle as HTMLElement).offsetTop
            if (toggleTop > document.body.scrollTop + innerHeight - 200)
              document.body.scrollTo(0, Math.max(headerdiv.offsetTop, toggleTop - innerHeight / 4))
            showToggle.dispatchEvent(new Event('click'))
          }
          // update_dom().then(() => {
          //   document
          //     .querySelector(`#super-container-${nextTargetId} mark.label`)
          //     ?.dispatchEvent(new MouseEvent("mousedown", { altKey: true }));
          // });
        }
      }
      return
    }
    // let unmodified ArrowUp select label on last context item (i.e. move up to parent)
    if (key == 'ArrowUp' && !modified) {
      // attempt to click on a hide toggle
      const hideToggle = document.querySelector(`.toggle.hide`)
      if (hideToggle) {
        hideToggle.dispatchEvent(new Event('click'))
        return
      }
      // see comments above about lastContext
      const lastContext = Array.from(document.querySelectorAll('.container.target_context'))
        .filter(e => e.querySelector('mark.selected'))
        .sort((a, b) => item(b.getAttribute('item-id')).time - item(a.getAttribute('item-id')).time)[0]
      if (lastContext) {
        lastContext.querySelector('mark.label')?.dispatchEvent(new MouseEvent('mousedown', { altKey: true }))
        // also click on any hide toggle (which must be below new target)
        update_dom().then(() => {
          document.querySelector(`.toggle.hide`)?.dispatchEvent(new Event('click'))
        })
        return
      } else {
        // // attempt to click on a hide toggle
        // const hideToggle = document.querySelector(`.toggle.hide`);
        // if (hideToggle) {
        //   hideToggle.dispatchEvent(new Event("click"));
        //   return;
        // }
      }
    }

    // clear non-empty editor on unmodified escape or backspace/arrowup/arrowleft (if not handled above)
    if (editorText && (key == 'Escape' || key == 'Backspace' || key == 'ArrowUp' || key == 'ArrowLeft') && !modified) {
      e.preventDefault()
      hideIndex = hideIndexMinimal
      // this follows onTagClick behavior
      editorText = ''
      forceNewStateOnEditorChange = true // force new state
      // finalizeStateOnEditorChange = true; // finalize state
      lastEditorChangeTime = 0 // disable debounce even if editor focused
      onEditorChange(editorText)
      return
    }

    // resume-edit items on Shift-(save shortcut)
    if (
      (key == 'KeyS' && (e.metaKey || e.ctrlKey) && e.shiftKey) ||
      (key == 'Enter' && (e.metaKey || e.ctrlKey) && e.shiftKey)
    ) {
      e.preventDefault()
      resumeLastEdit()
      return
    }

    // disable various "unfocused" item editor shortcuts, focus on editor instead
    if (focusedItem >= 0) return // already focused on an item
    if (
      (key == 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) ||
      (key == 'KeyS' && (e.metaKey || e.ctrlKey)) ||
      (key == 'Slash' && (e.metaKey || e.ctrlKey)) ||
      (key == 'KeyI' && e.metaKey && e.shiftKey) ||
      (key == 'ArrowUp' && e.metaKey) ||
      (key == 'ArrowDown' && e.metaKey) ||
      key == 'Backspace' ||
      key == 'Tab' ||
      key == 'Escape'
    ) {
      e.preventDefault()
      hideIndex = hideIndexMinimal
      // scroll up to header if necessary
      if (document.body.scrollTop > headerdiv.offsetTop) document.body.scrollTo(0, headerdiv.offsetTop)
      tick().then(() => textArea(-1).focus())

      // create/run new item on create/save shortcuts
      if (
        (key == 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) ||
        (key == 'KeyS' && (e.metaKey || e.ctrlKey))
      ) {
        onEditorDone(editorText, e, false, e.metaKey || e.ctrlKey /*run*/)
      }
      // create new image item on image shortcut
      if (key == 'KeyI' && e.metaKey && e.shiftKey) {
        editor.insertImages(true)
      }
    }

    // forward unhandled key to window._on_key
    if (window['_on_key']) window['_on_key'](key, e)
  }

  function onFocus() {
    // NOTE: on ios (also android presumably), windows do not defocus when switching among split-screen windows
    if (ios || android) return // focus handled in focus/checkFocus below
    focused = document.hasFocus()
    if (focused) window['_focus_time'] = Date.now()
    // retreat to minimal hide index when window is defocused
    // if (!focused) hideIndex = hideIndexMinimal;
  }

  // global focus index is the one stored in local storage, or in focus hidden item as fallback
  let focusIndex // local focus index updated in focus()
  let onStorageFired = false
  function getGlobalFocusIndex() {
    let index = parseInt(localStorage.getItem('mindpage_focus_index')) || 0
    if (!onStorageFired && !anonymous) {
      const focusItem = hiddenItemsByName.get('focus')?.item
      if (focusItem?.index > index) return focusItem.index
    }
    return index
  }
  function setGlobalFocusIndex(index) {
    localStorage.setItem('mindpage_focus_index', index.toString())
    if (!onStorageFired && !anonymous) saveHiddenItem('focus', { index })
  }

  let lastBlurredElem
  function focus() {
    window['_focus_time'] = Date.now()
    if (!ios && !android) {
      onFocus() // focus based on document.hasFocus()
      return
    }
    if (focused) return // already focused
    if (!initialized) return // decline focus until initialized
    // NOTE: we ensure focus index increments are global by taking a max with Date.now()
    focusIndex = Math.max(getGlobalFocusIndex() + 1, Date.now())
    setGlobalFocusIndex(focusIndex)
    focused = true
    // see comment below; for cmd-tilde this works with an additional touch or keydown, but it does NOT allow single-touch switching, even if dispatched, and even if we disable touchstart/mousedown events and also focus on their targets below
    lastBlurredElem?.focus()
    lastBlurredElem = null
  }

  function checkFocus() {
    if (!ios && !android) return // focus handled in onFocus above
    if (!focused) return // not focused
    if (!initialized) return // decline focus changes until initialized
    const globalFocusIndex = getGlobalFocusIndex()
    if (focusIndex == globalFocusIndex) return // focus is fine
    if (focusIndex > globalFocusIndex) {
      // should not happen since localStorage is always incremented together with focusIndex
      // could indicate some sort of external manipulation of localStorage
      console.error('focus index is ahead of stored global index')
      return
    }
    focused = false
    // hideIndex = hideIndexMinimal;
    // NOTE: blurring on defocus enables touch-to-focus-on-other-window on ipad, which seems to require the original window to not have focus (double tap is needed if first tap is to blur), but also inhibits cmd-tilde switching on ipad (since blurring means there is nothing to switch back to), which is particularly problematic as this switching seems to be undetectable (see comments in onEditorFocus) -- we are able to work around this by restoring focus on last blurred element but an additional touch or keydown (e.g. Shift or Alt) is still needed (true regardless of whether we blur on defocus or not)
    lastBlurredElem = document.activeElement as HTMLElement
    lastBlurredElem?.blur()
  }

  function saveHiddenItem(name, item) {
    if (!initialized) throw new Error('saveHiddenItem called before initialized')
    if (anonymous) throw new Error('saveHiddenItem called on anonymous account')
    const wrapper = hiddenItemsByName.get(name)
    if (wrapper) {
      // replace existing hidden item
      wrapper.item = item
      if (readonly) return // no saving

      // console.debug("updating hidden item", name);
      let itemToSave = {
        hidden: true,
        time: Date.now(),
        attr: null, // we leave attr unused for now
        text: JSON.stringify(_.pick(wrapper, ['name', 'item'])), // save only name/item
      }
      // NOTE: if existing item is saving, we need to wait for its persistent id before we can update
      Promise.resolve(wrapper.saving || wrapper.id).then(saved_id => {
        encryptItem(itemToSave)
          .then(itemToSave => {
            firestore()
              .collection('items')
              .doc(saved_id)
              .update(itemToSave)
              // .then(() => {
              //   console.debug("updated hidden item", name, item);
              // })
              .catch(console.error)
          })
          .catch(console.error)
      })
    } else {
      // create new hidden item
      const wrapper = { name, item, id: (Date.now() + sessionCounter++).toString(), saving: null }
      hiddenItems.set(wrapper.id, wrapper)
      hiddenItemsByName.set(wrapper.name, wrapper)
      if (readonly) return // no saving
      let itemToSave = {
        hidden: true,
        user: user.uid, // required for add
        time: Date.now(),
        attr: null, // we leave attr unused for now
        text: JSON.stringify(_.pick(wrapper, ['name', 'item'])), // save only name/item
      }
      wrapper.saving = new Promise((resolve, reject) => {
        encryptItem(itemToSave)
          .then(itemToSave => {
            firestore()
              .collection('items')
              .add(itemToSave)
              .then(doc => {
                // console.debug("created hidden item", JSON.stringify(itemToSave));
                hiddenItems.delete(wrapper.id) // remove under temp id
                hiddenItems.set(doc.id, wrapper) // add back under persistent id
                wrapper.id = doc.id // update id in wrapper
                wrapper.saving = null // no longer saving
                resolve(wrapper.id) // return persistent id
              })
              .catch(e => {
                console.error(e)
                reject(e)
              })
          })
          .catch(e => {
            console.error(e)
            reject(e)
          })
      })
    }
  }

  function deleteHiddenItem(id) {
    if (!id) return // nothing to delete
    if (!initialized) throw new Error('deleteHiddenItem called before initialized')
    const wrapper = hiddenItems.get(id)
    if (wrapper) {
      hiddenItems.delete(wrapper.id)
      hiddenItemsByName.delete(wrapper.name)
    }
    if (readonly) return // no saving
    // console.debug("deleting hidden item", name);
    // NOTE: if item is saving, we need to wait for its persistent id before we can delete
    Promise.resolve(wrapper?.saving || id).then(saved_id => {
      firestore()
        .collection('items')
        .doc(saved_id)
        .delete()
        // .then(() => {
        //   console.debug("deleted hidden item", name);
        // })
        .catch(console.error)
    })
  }

  function hiddenItemChangedRemotely(name, change_type) {
    // check window focus if "focus" hidden item is changed (added, modified, or removed)
    if (name == 'focus') {
      checkFocus()
      return
    }

    // re-render local item for which global_store_<id> is changed remotely
    if (name.match(/^global_store_/)) {
      const id = name.replace(/^global_store_/, '')
      // warn if <id> (always saved_id for global_store) is missing locally
      // note since item is remote it can not be under temp id locally
      // also note an item must exist before its global_store does
      if (!_exists(id)) {
        console.warn(`missing local item for remote-${change_type} hidden item ${name}`)
        return
      }
      // console.debug("hiddenItemChangedRemotely", name, change_type, hiddenItemsByName.get(name)?.item);
      item(id).global_store = _.cloneDeep(hiddenItemsByName.get(name)?.item) // sync global_store on item
      _item(id).invalidate_elem_cache(true /*force_render*/)
      return
    }
  }

  function onTouchStart(e) {
    // if no focus, ignore event and let checkFocus recover focus
    // if (!focused) {
    //   e.preventDefault();
    //   e.stopPropagation();
    // }
    focus() // ensure focus
    // e.target.focus();
  }

  function onMouseDown(e) {
    onTouchStart(e) // handle like touchstart
  }

  // redirect window.onerror to console.error (or alert if .console not set up yet)
  function onError(e) {
    if (!consolediv) return // can happen during login process
    let msg = errorMessage(e)
    console.error(msg)
  }

  function onWebcamClick(e) {
    intro = !intro
    e.stopPropagation()
    ;(e.target as HTMLElement).classList.toggle('intro')
  }

  // retrieve host name, in globalThis.request on server side (see server.ts)
  const hostname = typeof location == 'undefined' ? globalThis.hostname : location.hostname

  // custom directory for some static files, based on hostname
  const hostdir = ['mind.page', 'mindbox.io', 'olcan.com'].includes(hostname) ? hostname : 'other'

  // favicon version to force updates, especially on iOS
  const favicon_version = 1
</script>

{#if user && processed}
  <div
    class="items"
    bind:this={itemsdiv}
    class:multi-column={columnCount > 1}
    class:hide-videos={narrating}
    class:focused
  >
    {#each { length: columnCount + 1 } as _, column}
      <div
        class="column"
        class:multi-column={columnCount > 1}
        class:hidden={column == columnCount}
        class:focused
        class:editorFocused
      >
        <div class="column-padding" on:mousedown={onColumnPaddingMouseDown} />
        {#if column == 0}
          <div class="header" bind:this={headerdiv} on:click={() => textArea(-1).focus()}>
            <div class="header-container" class:focused={editorFocused}>
              <div class="editor">
                <Editor
                  id_suffix="mindbox"
                  bind:this={editor}
                  bind:text={editorText}
                  bind:focused={editorFocused}
                  lockCaret={false}
                  showButtons={true}
                  cancelOnDelete={true}
                  createOnAnyModifiers={true}
                  clearOnShiftBackspace={true}
                  allowCommandCtrlBracket={true}
                  {onEditorKeyDown}
                  onEdited={onEditorChange}
                  onFocused={onEditorFocused}
                  {onPastedImage}
                  onDone={onEditorDone}
                  onPrev={onPrevItem}
                  onNext={onNextItem}
                />
              </div>
              <div class="spacer" />
              {#if user}
                <img
                  class="user"
                  class:anonymous
                  class:readonly
                  class:signedin
                  src={user.photoURL}
                  alt={user.displayName || user.email}
                  title={user.displayName || user.email}
                  on:click|stopPropagation={() => (!signedin ? signIn() : signOut())}
                />
              {/if}
            </div>
            <div class="status" class:hasDots={dotCount > 0} on:click={onStatusClick}>
              <span class="console-summary" bind:this={summarydiv} on:click={onConsoleSummaryClick} />
              {#if dotCount > 0}
                {#if showDotted}
                  <div class="triangle">▲</div>
                {:else}
                  <div class="dots">
                    {#each { length: dotCount } as _, index}<span class:matching={items[index].matching}>•</span>{/each}
                  </div>
                {/if}
              {/if}
              {#if items.length > 0}
                <div class="counts">
                  {#if matchingItemCount > 0}
                    &nbsp;<span class="matching">{matchingItemCount} matching items</span>
                  {:else}
                    {items.length} items
                  {/if}
                </div>
              {/if}
              <div class="console" bind:this={consolediv} on:click={onConsoleClick} />
            </div>
          </div>
        {/if}

        {#each items as item (item.id)}
          {#if item.column == column || (item.index >= hideIndex && column == columnCount)}
            {#if column < columnCount}
              {#if item.index == hideIndex}
                {#each toggles as toggle}
                  {#if hideIndex < toggle.end}
                    <div class="toggle show" on:click={() => toggleItems(toggle.end)}>
                      ▼ {toggle.positionBased
                        ? ''
                        : items[toggle.start].timeString || itemTimeString(items[toggle.start].time)}
                      <span class="count">show {toggle.end - toggle.start} items</span>
                    </div>
                  {/if}
                {/each}
              {:else if item.index < hideIndex}
                {#each toggles as toggle}
                  {#if item.index == toggle.start}
                    <div class="toggle hide" on:click={() => toggleItems(toggle.start)}>
                      ▲ {toggle.positionBased
                        ? ''
                        : items[toggle.start].timeString || itemTimeString(items[toggle.start].time)}
                      <span class="count">hide {Math.min(hideIndex, items.length) - toggle.start} items</span>
                    </div>
                  {/if}
                {/each}
              {/if}
            {/if}
            {#if item.index < hideIndex || (column == columnCount && item.index >= renderStart && item.index < renderEnd)}
              <Item
                onEditing={onItemEditing}
                onFocused={onItemFocused}
                onEdited={onItemEdited}
                onEditorKeyDown={onItemEditorKeyDown}
                onRun={onItemRun}
                onTouch={onItemTouch}
                onUpdate={onItemUpdate}
                onPush={onItemPush}
                onResized={onItemResized}
                onEscape={onItemEscape}
                {onImageRendering}
                {onImageRendered}
                {onPastedImage}
                {onTagClick}
                {onLinkClick}
                {onLogSummaryClick}
                onPrev={onPrevItem}
                onNext={onNextItem}
                bind:text={item.text}
                bind:editing={item.editing}
                bind:focused={item.focused}
                editable={item.editable}
                pushable={item.pushable}
                saving={item.saving}
                running={item.running}
                admin={item.admin}
                source={item.source}
                path={item.attr ? item.attr.path : ''}
                hidden={item.index >= hideIndex || (item.dotted && !showDotted)}
                showLogs={item.showLogs}
                height={item.height}
                time={item.time}
                index={item.index}
                id={item.id}
                name={item.name}
                label={item.label}
                labelUnique={item.labelUnique}
                labelText={item.labelText}
                hash={item.hash}
                deephash={item.deephash}
                bind:version={item.version}
                missingTags={item.missingTags.join(' ')}
                matchingTerms={item.matchingTerms.join(' ')}
                matchingTermsSecondary={item.matchingTermsSecondary.join(' ')}
                matching={item.matching}
                target={item.target}
                target_context={item.target_context}
                timeString={item.timeString}
                timeOutOfOrder={item.timeOutOfOrder}
                updateTime={item.updateTime}
                createTime={item.createTime}
                depsString={item.depsString}
                dependentsString={item.dependentsString}
                aboveTheFold={item.aboveTheFold}
                leader={item.leader}
                runnable={item.runnable}
                scripted={item.scripted}
                macroed={item.macroed}
              />
              {#if item.nextColumn >= 0 && item.index < hideIndex}
                <div class="section-separator">
                  <hr />
                  {item.index + 2}<span class="arrows">{item.arrows}</span
                  >{#if item.nextItemInColumn >= 0 && item.nextItemInColumn < hideIndex}
                    &nbsp;
                    {item.nextItemInColumn + 1}<span class="arrows">↓</span>
                  {/if}
                  <hr />
                </div>
              {/if}
            {/if}
          {/if}
        {/each}
      </div>
    {/each}
  </div>
  <!-- <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.2.0/build/languages/mathematica.min.js"></script> -->
  <!-- <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.2.0/build/languages/swift.min.js"></script> -->
{/if}

{#if !user || !initialized || !headerScrolled || signingIn || signingOut}
  <div class="loading">
    <Circle2 size="60" unit="px" />
  </div>
{/if}

<Modal bind:this={modal} {onPastedImage} />

<svelte:window
  on:keydown={onKeyDown}
  on:focus={onFocus}
  on:focusin={onFocus}
  on:blur={onFocus}
  on:error={onError}
  on:touchstart={onTouchStart}
  on:mousedown={onMouseDown}
  on:unhandledrejection={onError}
  on:popstate={onPopState}
/>

<!-- increase list item padding on android, otherwise too small -->
<!-- also hack for custom font wrapping issue (if needed) -->
{#if android}
  <style>
    span.list-item {
      margin-left: 0 !important;
    }
    .editor textarea,
    .editor .backdrop {
      padding-right: 11px !important;
      /* font-family: monospace !important; */
    }
    /* .items {
      min-height: 100%;
    }
    .column-padding {
      display: none;
    } */
  </style>
{/if}

{#if inverted}
  <style>
    html,
    img {
      filter: invert(100%);
    }
    textarea {
      caret-color: #0ff !important; /* maintain red (#f00) caret */
    }
  </style>
{/if}

{#if narrating}
  <style>
    .items {
      /* padding to make it easier to crop video */
      padding: 0 10px;
      padding-top: 10px;
    }
    .webcam-background {
      position: fixed;
      z-index: 100;
      top: 0;
      left: 0;
      display: flex;
      width: 100%;
      height: 100%;
      justify-content: center;
      align-items: center;
      min-height: 100%;
      background: rgba(17, 17, 17, 0.8);
      opacity: 0;
      pointer-events: none;
      transition: all 1s ease;
    }
    .webcam-background.intro {
      opacity: 1;
      pointer-events: all;
    }
    .webcam {
      /* background: #333; */
      width: 550px;
      height: 400px;
      max-width: 27.5vw;
      max-height: 20vw;
      position: fixed;
      bottom: 0;
      right: 0;
      z-index: 1000; /* above modal */
      /* box-shadow: 0px 0px 20px 5px black; */
      /* border: 5px solid white; */
      /* border-radius: 50%; */
      /* border-bottom: 1px solid #222; */
      transition: all 1s ease;
    }
    .webcam.intro {
      width: 68.75vw;
      height: 50vw;
      max-width: 68.75vw;
      max-height: 50vw;
    }
  </style>

  <div class="webcam-background" class:intro on:click|self={onWebcamClick} />
  <!-- svelte-ignore a11y-media-has-caption -->
  <video id="webcam-video" class="webcam" class:intro style="visibility: hidden; z-index:-100" />
  <canvas id="webcam-canvas" class="webcam" class:intro on:click|self={onWebcamClick} />

  <script>
    if (navigator?.mediaDevices?.getUserMedia) {
      if (navigator.mediaDevices.enumerateDevices) {
        console.log(`initializing webcam, config: '${localStorage.getItem('mindpage_narrating')}'; available devices:`)
        navigator.mediaDevices.enumerateDevices().then(devices => {
          devices.forEach(device => {
            if (device.kind == 'videoinput') console.log(device.deviceId, device.label)
          })
        })
      }

      // set up video and green screen canvas
      // see https://jameshfisher.com/2020/08/10/how-to-implement-green-screen-in-webgl/
      const video = document.getElementById('webcam-video')
      const canvas = document.getElementById('webcam-canvas')
      const gl = canvas.getContext('webgl')
      const vs = gl.createShader(gl.VERTEX_SHADER)
      gl.shaderSource(vs, 'attribute vec2 c; void main(void) { gl_Position=vec4(c, 0.0, 1.0); }')
      gl.compileShader(vs)
      const fs = gl.createShader(gl.FRAGMENT_SHADER)
      gl.shaderSource(fs, document.getElementById('fragment-shader').innerText)
      gl.compileShader(fs)
      const prog = gl.createProgram()
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.linkProgram(prog)
      gl.useProgram(prog)
      const vb = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vb)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 1, -1, -1, 1, -1, 1, 1]), gl.STATIC_DRAW)
      const coordLoc = gl.getAttribLocation(prog, 'c')
      gl.vertexAttribPointer(coordLoc, 2, gl.FLOAT, false, 0, 0)
      gl.enableVertexAttribArray(coordLoc)
      gl.activeTexture(gl.TEXTURE0)
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      const texLoc = gl.getUniformLocation(prog, 'tex')
      const texWidthLoc = gl.getUniformLocation(prog, 'texWidth')
      const texHeightLoc = gl.getUniformLocation(prog, 'texHeight')
      const keyColorLoc = gl.getUniformLocation(prog, 'keyColor')
      const similarityLoc = gl.getUniformLocation(prog, 'similarity')
      const smoothnessLoc = gl.getUniformLocation(prog, 'smoothness')
      const spillLoc = gl.getUniformLocation(prog, 'spill')
      const toggleLoc = gl.getUniformLocation(prog, 'toggle')

      // start webcam video
      navigator.mediaDevices
        .getUserMedia({
          video: _.merge(
            {
              width: 1100,
              height: 800,
              facingMode: 'user',
            },
            JSON.parse(localStorage.getItem('mindpage_narrating') || '{}')
          ),
        })
        .then(stream => {
          video.srcObject = stream
          video.play()
          // if we can not process the video, show it directly
          if (!video.requestVideoFrameCallback) {
            video.style.visibility = 'visible'
            video.style.zIndex = 1000
            return
          }
          function processFrame(now, metadata) {
            canvas.width = metadata.width
            canvas.height = metadata.height
            gl.viewport(0, 0, metadata.width, metadata.height)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video)
            gl.uniform1i(texLoc, 0)
            gl.uniform1f(texWidthLoc, metadata.width)
            gl.uniform1f(texHeightLoc, metadata.height)
            gl.uniform3f(keyColorLoc, 0, 1, 0)
            // see sliders at https://jameshfisher.com/2020/08/11/production-ready-green-screen-in-the-browser/
            gl.uniform1f(similarityLoc, _green_screen ? 0.49 : 0)
            gl.uniform1f(smoothnessLoc, 0.0)
            gl.uniform1f(spillLoc, 0.05)
            gl.drawArrays(gl.TRIANGLE_FAN, 0, 4)
            video.requestVideoFrameCallback(processFrame)
          }
          video.requestVideoFrameCallback(processFrame)
        })
        .catch(console.error)
    } else {
      alert('unable to access webcam')
    }
  </script>
{/if}

<svelte:head>
  <title>{hostname + (anonymous && !readonly ? '-admin' : '')}</title>
  <link rel="icon" type="image/x-icon" href="{hostdir}/favicon.ico?v={favicon_version}" />
  <link rel="icon" type="image/png" sizes="32x32" href="{hostdir}/favicon-32x32.png?v={favicon_version}" />
  <link rel="icon" type="image/png" sizes="16x16" href="{hostdir}/favicon-16x16.png?v={favicon_version}" />
  <!-- see https://stackoverflow.com/a/25041921 about custom apple-touch-icon location -->
  <link rel="apple-touch-icon" type="image/png" href="{hostdir}/apple-touch-icon.png?v={favicon_version}" />
  <link rel="manifest" href="manifest.json?v={favicon_version}" />
</svelte:head>

<style>
  :global(html) {
    font-family: 'Open Sans', sans-serif;
    font-weight: 400;
    /* Safari renders heavier fonts under default subpixel-antialiasing */
    -webkit-font-smoothing: antialiased;
    /* disable ligatures which can be confusing and _may_ cause line wrapping issues */
    /* font-variant-ligatures: none; */
    /* disable tap highlights on ios and android */
    -webkit-tap-highlight-color: transparent;
  }
  :global(b, strong) {
    font-weight: 700;
  }
  /* disable scrollbars to save space (see https://stackoverflow.com/a/56926685) */
  :global(html, body) {
    -ms-overflow-style: none !important;
    scrollbar-width: none !important;
    overflow: auto; /* necessary on iOS */
  }
  :global(body::-webkit-scrollbar) {
    display: none;
  }

  /* customize selection colors */
  /* see https://css-tricks.com/almanac/selectors/s/selection/ */
  :global(::-moz-selection) {
    color: white;
    background: rgba(255, 0, 0, 0.5);
  }
  :global(::selection) {
    color: white;
    background: rgba(255, 0, 0, 0.5);
  }

  .loading {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    width: 100%;
    height: 100%;
    justify-content: center;
    align-items: center;
    /* NOTE: if you add transparency, initial zero-height layout and unscrolled header will be visible */
    background: rgba(17, 17, 17, 1);
  }
  .header {
    max-width: 100%;
  }
  .header-container {
    display: flex;
    padding: 10px;
    background: #171717;
    border-radius: 0 0 5px 5px;
    border-bottom: 1px solid #222;
    /*padding-left: 2px;*/ /* matches 1px super-container padding + 1px container border */
  }
  .header-container.focused {
    background: #222; /* #222 matches .user background */
    border-bottom: 1px solid #333;
  }
  .editor {
    width: 100%;
    /* push editor down/left for more clearance for buttons and from profile picture */
    margin-top: 4px;
    margin-bottom: -5px;
    margin-left: -4px;
    margin-right: 5px;
  }
  /* remove dashed border when top editor is unfocused */
  :global(.header .editor .backdrop:not(.focused)) {
    border: 1px solid transparent;
  }
  /* lighten solid border when top editor is focused */
  :global(.header .editor .backdrop.focused) {
    border: 1px solid #333;
    /* border: 1px solid transparent; */
  }
  .spacer {
    flex-grow: 1;
  }
  .user {
    height: 56px; /* 45px = focused height of single-line editor (also see @media query below) */
    width: 56px;
    min-width: 56px; /* seems necessary to ensure full width inside flex */
    border-radius: 50%;
    margin: -5px;
    margin-left: 0;
    background: #222;
    cursor: pointer;
    overflow: hidden;
  }
  .user.anonymous:not(.readonly).signedin {
    background: green;
  }
  .console {
    display: none;
    position: absolute;
    min-height: 20px; /* covers .console-summary (w/ +8px padding) */
    min-width: 60px; /* covers .console-summary */
    top: 0;
    left: 0;
    z-index: 10;
    padding: 4px;
    color: #999;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 4px;
    border: 1px solid #222;
    font-family: 'JetBrains Mono', monospace;
    font-weight: 300;
    text-align: left;
    -webkit-touch-callout: auto;
    -webkit-user-select: auto;
    user-select: auto;
    white-space: pre-wrap;
  }
  :global(.console-debug) {
    color: #555;
  }
  :global(.console-info) {
    color: #666;
  }
  :global(.console-log) {
    color: #999;
  }
  :global(.console-warn) {
    color: yellow;
  }
  :global(.console-error) {
    color: red;
  }
  .status {
    padding: 4px;
    height: 20px;
    text-align: center;
    font-family: 'JetBrains Mono', monospace;
    font-weight: 300;
    font-size: 12px;
    color: #999;
    position: relative;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .status .console-summary {
    position: absolute;
    left: 0;
    top: 0;
    padding-top: 4px;
    height: 24px; /* matches .status height(+padding) above */
    min-width: 60px; /* ensure clickability */
    max-width: 30%; /* try not to cover center (item dots) */
    text-align: left;
    overflow: hidden;
    padding-left: 4px;
    cursor: pointer;
  }
  .status.hasDots {
    cursor: pointer;
  }
  .status .dots {
    color: #666;
  }
  .status .counts {
    font-family: sans-serif;
    font-size: 14px;
    position: absolute;
    right: 0;
    top: 0;
    padding-right: 4px; /* matches .corner inset on first item */
    padding-top: 4px;
  }
  :global(.status .counts .unit, .status .counts .comma) {
    color: #666;
    font-size: 80%;
  }
  .status .counts .matching,
  .status .dots .matching {
    color: #9f9;
  }

  .items {
    width: 100%;
    display: flex;
    /* prevent horizontal overflow which causes stuck zoom-out on iOS Safari */
    /* (note that overflow-x did not work but this is fine too) */
    overflow: hidden;
    /* fill full height of page even if no items are shown */
    /* otherwise (tapped) .console can be cut off at the bottom when there are no items */
    /* also prevents content height going below 100%, which can trigger odd zooming/scrolling effects in iOS  */
    min-height: 100%;

    /* bottom padding for easier tapping on last item, also more stable editing/resizing of bottom items */
    /* matches .column-padding to enable scrolling down to top of header regardless of .items contents */
    padding-bottom: 70vh;
    /* box-sizing: border-box; */
  }
  /* .items.multi-column {
    padding-bottom: 0;
  } */
  .items.focused {
    background: rgb(10, 10, 10);
    /* border-left: 1px solid #333; */
    /* border-right: 1px solid #333; */
  }
  :global(#sapper) {
    min-height: 100%;
  }

  .column {
    flex: 1;
    /* NOTE: BOTH min/max width are necessary to get proper flexing behavior */
    min-width: 0px;
    max-width: 750px; /* see minColumnWidth for effective min-width */
    /* allow absolute-positioned .hidden items */
    position: relative;
    /* prevents content height going below 100%, which can trigger odd zooming/scrolling effects in iOS  */
    min-height: 100%;
    /* margin-right ensures absolute-positioned elements can use width:100% to get same width as regular elements */
    /* also ensures consistent width as items switch columns (conditional left/right-margins would also work) */
    /* also helps avoid scroll bar on desktop (which conditional left/right margins would not)*/
    margin-right: 8px;
  }
  /* column padding allows scrolling top items to ~anywhere on screen */
  .column-padding {
    height: 70vh;
  }
  .column:first-child .column-padding {
    background: #171717; /* matches .header-container unfocused background */
  }
  .column:first-child.editorFocused .column-padding {
    background: #222; /* matches .header-container focused background */
  }

  /* .column:last-child {
    margin-right: 0;
  } */
  /* .column:last-child {
    margin-right: 0;
  } */
  /* single-column layout can remove margin since there is no concern of having columns w/ same width */
  .column:not(.multi-column) {
    margin-right: 1px; /* consistent w/ 1px padding-left of .super-container */
  }

  :global(.items:not(.focused) .item-menu),
  :global(.items:not(.focused) .log-summary),
  :global(.items:not(.focused) .deps-summary),
  :global(.items:not(.focused) .dependents-summary),
  :global(.items:not(.focused) .deps-and-dependents) {
    opacity: 0.5 !important;
  }
  :global(.items:not(.focused) .column-padding),
  :global(.items:not(.focused) .header) {
    opacity: 0.5;
  }
  :global(.items:not(.focused) .super-container),
  :global(.items:not(.focused) .toggle) {
    opacity: 0.75;
  }
  :global(.items:not(.focused) .super-container.target_context) {
    opacity: 0.85;
  }
  :global(.items:not(.focused) .super-container.target),
  :global(.items:not(.focused) .super-container.editing) {
    opacity: 0.95;
  }

  .column.hidden {
    position: absolute;
    left: -100000px;
    /* right: 750px; */
    /* the following (when used together) work even if hidden column is on screen */
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
    z-index: -10;
  }

  .section-separator {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 40px; /* 40px offset height assumed by column layout */
    color: #444; /* same as time indicators */
    font-size: 16px;
  }
  .section-separator .arrows {
    margin-bottom: 5px; /* aligns better w/ surrounding text */
    font-family: 'JetBrains Mono', monospace;
    font-weight: 300;
    font-size: 20px;
  }
  .section-separator hr {
    display: inline-block;
    vertical-align: middle;
    background: transparent;
    border: 0;
    border-top: 2px solid #444;
    height: 1px; /* disappears if both height and border are 0 */
    width: 25%;
    margin: 0 15px;
  }

  /* allow time strings to overlap preceding section separators */
  :global(.section-separator + .super-container.timed) {
    margin-top: -24px;
  }

  /* allow time strings to overlap preceding .toggle */
  :global(.toggle + .super-container.timed) {
    margin-top: -24px;
  }
  .toggle {
    display: flex;
    justify-content: center;
    align-items: center;
    color: #999;
    background: #222;
    /* color: black; */
    /* background: #666; */
    font-weight: 600;
    border-radius: 4px;
    cursor: pointer;
    width: fit-content;
    white-space: nowrap;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .toggle .count {
    font-size: 80%;
    font-weight: 400;
    color: #777;
    display: none;
  }
  .toggle.show {
    font-size: 20px;
    margin: 20px auto;
    padding: 15px 25px;
  }
  .toggle.show .count {
    margin-left: 25px;
  }
  .toggle.hide {
    font-size: 16px;
    margin: 14px auto;
    padding: 10px 20px;
  }
  .toggle.hide .count {
    margin-left: 20px;
  }
  .toggle + .toggle {
    display: none;
  }

  /* override italic comment style of sunburst */
  :global(.hljs-comment) {
    font-style: normal;
    color: #666;
  }
  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    .column:not(.multi-column) {
      margin-right: 0; /* consistent w/ 0 padding-left of .super-container on small screen */
    }
    .header-container {
      /*padding-left: 1px;*/ /* matches 1px container border, no super-container padding */
      padding-left: 10px; /* not best use of space, but looks good and avoids edge on curved screens */
      padding-right: 6px; /* reduced padding to save space */
    }
    .user {
      height: 52px; /* 41px = height of single-line editor (on narrow window) */
      width: 52px;
      min-width: 52px;
    }
  }
</style>
