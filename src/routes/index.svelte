<script context="module" lang="ts">
  // server-side preload function, see server.ts for comments
  export async function preload(page, session) {
    // this.error(404, 'Not found')
    return process['server-preload'](page, session) // see server.ts
  }
</script>

<script lang="ts">
  const isClient = typeof window !== 'undefined'
  // import firebase via client.ts (can also be via server.ts if preloading used again)
  const firebase = globalThis.firebase
  const {
    getAuth,
    onAuthStateChanged,
    GoogleAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    setPersistence,
    browserLocalPersistence,
  } = firebase?.auth ?? {}
  const {
    getFirestore,
    collection,
    doc,
    getDoc,
    getDocs,
    setDoc,
    addDoc,
    updateDoc,
    deleteDoc,
    query,
    where,
    orderBy,
    onSnapshot,
  } = firebase?.firestore ?? {}
  const { getStorage, ref, uploadBytes, getBlob } = firebase?.storage ?? {}

  const _ = globalThis['_'] // imported in client.ts
  import { Jumper } from 'svelte-loading-spinners'
  import Modal from '../components/Modal.svelte'
  import Editor from '../components/Editor.svelte'
  import Item from '../components/Item.svelte'
  export let items = []
  export let items_preload = [] // items returned by server preload (see above and server.ts)
  export let server_error = null // error from server?
  export let server_warning = null // warning from server?
  export let server_name
  export let server_ip
  export let client_ip
  let user = null
  let deletedItems = []
  let editingItems = []
  let focusedItem = -1
  let editorFocused = false
  let focused = false
  let focus_time = 0
  let signedin = false
  let admin = false
  let anonymous = false
  let readonly = false
  let url_hash = isClient ? decodeURIComponent(location.hash) : null
  let url_params = isClient ? Object.fromEntries(Array.from(new URL(location.href).searchParams.entries())) : null
  let fixed = !!url_params?.shared
  let shared_key = url_params?.shared?.replace(/^\w+\//, '')
  let sharer = url_params?.shared?.match(/^(\w+)\//)?.pop() // may be set to user.uid later
  let sharer_name // fetched via /user/<uid> once sharer uid is determined
  let sharer_short_name
  // let spinnerSize = isClient ? Math.max(60, Math.min(innerWidth, innerHeight) * 0.2) : 0 // resized in checkLayout
  let zoom = isClient && localStorage.getItem('mindpage_zoom')
  let inverted = isClient && localStorage.getItem('mindpage_inverted') == 'true'
  let narrating = isClient && localStorage.getItem('mindpage_narrating') != null
  let green_screen = isClient && localStorage.getItem('mindpage_green_screen') == 'true'
  if (isClient) window['_green_screen'] = green_screen
  let intro = narrating // larger centered narration window
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
      // 'tick' first to ensure svelte update
      tick().then(() => {
        // skip animation frame to ensure DOM is updated for running=true
        // (otherwise only option is an arbitrary delay since polling DOM does not work)
        // (see https://stackoverflow.com/a/57659371 and other answers to that question)
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      })
    })
  }

  // returns item with name (unique label)
  // returns null if missing, or if multiple items match label
  // logs errors to console.error unless second argument (silent) is true
  // second argument can also be object for more readability
  // additional arguments are for internal use
  function _item(name: string, silent: any = false, read_only = undefined, default_read_only_id = undefined): any {
    if (!name) return null
    if (typeof silent == 'object') ({ silent = false, read_only, default_read_only_id } = silent)
    let item
    if (name.startsWith('#')) {
      // item is specified by unique label (i.e. name)
      const ids = idsFromLabel.get(name.toLowerCase())
      if (!ids || ids.length == 0) {
        if (!silent) console.error(`_item '${name}' not found`)
        return null
      } else if (ids.length > 1) {
        if (!silent) console.error(`_item '${name}' is ambiguous (${ids.length} items)`)
        return null
      }
      item = items[indexFromId.get(ids[0])]
    } else {
      // item is specified by id, with optional id: prefix to be dropped
      let id = name.startsWith('id:') ? name.substring(3) : name
      id = tempIdFromSavedId.get(id) ?? id // convert temporary id
      const index = indexFromId.get(id)
      if (index === undefined) {
        if (!silent) console.error(`_item '${name}' not found`)
        return null
      }
      item = items[index]
    }
    read_only ??= item.id == default_read_only_id
    return Object.freeze(new _Item(item.id, read_only)) // defined below
  }

  // same as _item, but for existence checks, and allows multiple matches
  function _exists(name: string, allow_multiple = true): any {
    if (!name) return false
    if (name.startsWith('#')) {
      // item is specified by unique label (i.e. name)
      const ids = idsFromLabel.get(name.toLowerCase())
      return allow_multiple ? ids?.length > 0 : ids?.length == 1
    } else {
      // item is specified by id, with optional id: prefix to be dropped
      let id = name.startsWith('id:') ? name.substring(3) : name
      id = tempIdFromSavedId.get(id) ?? id // convert temporary id
      const index = indexFromId.get(id)
      return index !== undefined
    }
  }

  // creates a new item with the given text and options
  // third argument (attr) is used internally for installed and shared items
  // default mindbox_text == undefined maintains existing mindbox text, sensible for programmatic creation
  // use mindbox_text == '' to force clear, sensible for item creation via commands (as in handleCommandReturn)
  // use mindbox_text == null to let onEditorDone (including any handled command) determine mindbox text
  // use emulate_button == true to emulate "create" button behavior
  // use return_alerts == true to return alert message strings (useful for background calls)
  function _create(
    text = '',
    {
      run = false,
      edit = false,
      history = false,
      command = false,
      mindbox_text = undefined,
      emulate_button = false,
      return_alerts = false,
    } = {},
    attr = null
  ) {
    if (emulate_button) {
      history = true
      command = true
      mindbox_text = null // maintain text determined by onEditorDone
    }

    // disable scrolling during creation unless emulating create button
    const wasScrollingDisabled = disableScrollingOnLayout
    if (!emulate_button) disableScrollingOnLayout = true

    // save mindbox text to be restored (or set) below
    if (mindbox_text !== null) {
      ignoreEditorChanges = true // ignore changes to editor from onEditorDone (e.g. by commands handled synchronously)
      mindbox_text ??= editorText
    }

    // trigger onEditorDone, which may return a promise, an item, or a string on error (if return_alerts==true)
    const item = onEditorDone(
      text,
      history ? {} : null, // null event disables key handling, history, etc
      false, // not cancelled
      !!run, // run?
      edit == true, // edit? (true/false only, null requires keyboard event)
      attr, // used internally for installed and shared items
      !command, // ignore command unless command truthy
      return_alerts // return alert messages? (instead of display in alert dialog)
    )

    // restore mindbox text
    if (mindbox_text !== null) {
      ignoreEditorChanges = false // re-enable changes to editor
      lastEditorChangeTime = 0 // disable debounce even if editor focused
      onEditorChange(mindbox_text)
    }

    // restore scrolling to original state
    disableScrollingOnLayout = wasScrollingDisabled

    return item
  }

  // _items returns any number of matches, most recent first
  function _items(label: string = '') {
    let ids
    if (label) {
      // try label as name (unique label or id)
      const item = _item(label, { silent: true })
      if (item) return [item]
      // return any ids for non-unique label
      ids = idsFromLabel.get(label.toLowerCase())
    } else {
      // return all items
      ids = items.map(item => item.id)
    }
    if (!ids) return []
    if (ids.length == 1) return [_item(ids[0])]
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

  // _modal shows a modal dialog
  function _modal(content, options = {}) {
    return modal.show(_.merge(typeof content == 'string' ? { content } : content, options))
  }

  // _modal_close closes/cancels all modals or specified modal w/ optional output
  function _modal_close(promise = undefined, output = undefined) {
    return modal.close(promise, output)
  }

  // _modal_update updates an existing modal w/ given options
  function _modal_update(promise, content, options = {}) {
    return modal.update(promise, _.merge(typeof content == 'string' ? { content } : content, options))
  }

  // _modal_visible returns true if specified (or any) modal is visible
  function _modal_visible(promise = undefined) {
    return modal.visible(promise)
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
              items: items.length,
              total_text_length: textLength,
              oldest_item_time: oldestTime,
              oldest_item_time_string: oldestTimeString,
            },
    })
    Object.defineProperty(window, '_readonly', { get: () => readonly })
    Object.defineProperty(window, '_stack', { get: () => evalStack.slice() }) // return copy not reference
    Object.defineProperty(window, '_this', { get: () => _item(evalStack[evalStack.length - 1]) })
    Object.defineProperty(window, '_that', { get: () => _item(evalStack[0]) })
    Object.defineProperty(window, '_focused', { get: () => focused })
    Object.defineProperty(window, '_focus_time', { get: () => focus_time })
    Object.defineProperty(window, '_instance', { get: () => instance })
    Object.defineProperty(window, '_instances', { get: () => instances })
    Object.defineProperty(window, '_primary', { get: () => primary })
    window['_item'] = _item
    window['__item'] = item // internal item(...) function (for debugging only)
    // internal item array and other state (for debugging only)
    Object.defineProperty(window, '__items', { get: () => items })
    Object.defineProperty(window, '__toggles', { get: () => toggles })
    Object.defineProperty(window, '__hideIndex', { get: () => hideIndex })
    window['_items'] = _items
    window['_exists'] = _exists
    window['_create'] = _create
    window['_labels'] = _labels
    window['_sublabels'] = _sublabels
    window['_modal'] = _modal
    window['_modal_close'] = _modal_close
    window['_modal_update'] = _modal_update
    window['_modal_visible'] = _modal_visible
    window['_modal_alert'] = _modal_alert
    window['_modal_confirm'] = _modal_confirm
    window['_modal_prompt'] = _modal_prompt
    window['_delay'] = _delay
    window['_update_dom'] = update_dom
    window['_scroll_to'] = scrollTo
    window['_encrypt'] = encrypt
    window['_decrypt'] = decrypt
    window['_encrypt_bytes'] = encrypt_bytes
    window['_decrypt_bytes'] = decrypt_bytes
    window['_encrypt_item'] = encryptItem
    window['_decrypt_item'] = decryptItem
    window['_render_item'] = renderItem
    window['_parse_tags'] = parseTags
    window['_parse_label'] = parseLabel
    window['_replace_tags'] = replaceTags
    window['_resolve_tags'] = resolveTags
    window['_resolve_tag'] = resolveTag
    window['_special_tag'] = isSpecialTag
    window['_stringify'] = stringify
    window['_byte_stringify'] = byte_stringify
    // encoding/decoding/hashing functions
    window['_encode'] = encode
    window['_encode_utf8'] = encode_utf8
    window['_encode_utf8_array'] = encode_utf8_array
    window['_encode_byte_array'] = encode_byte_array
    window['_concat_byte_arrays'] = concatByteArrays
    window['_encode_base64'] = encode_base64
    window['_decode'] = decode
    window['_decode_utf8'] = decode_utf8
    window['_decode_utf8_array'] = decode_utf8_array
    window['_decode_byte_array'] = decode_byte_array
    window['_decode_base64'] = decode_base64
    window['_hash'] = hash
    window['_hash_32_djb2'] = hash_32_djb2
    window['_hash_32_fnv1a'] = hash_32_fnv1a
    window['_hash_32_murmur3'] = hash_32_murmur3
    window['_hash_52_fnv1a'] = hash_52_fnv1a
    window['_hash_64_fnv1a'] = hash_64_fnv1a
    window['_hash_128_murmur3_x64'] = hash_128_murmur3_x64
    window['_hash_128_murmur3_x86'] = hash_128_murmur3_x86
    window['_hash_160_sha1'] = hash_160_sha1
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
    read_only: boolean
    constructor(id, read_only = false) {
      this.id = id
      this.read_only = read_only
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
    get running(): boolean {
      return !!item(this.id).running
    }
    get saving(): boolean {
      return !!item(this.id).saving
    }
    get saving_global_store(): boolean {
      const _item = item(this.id)
      if (!_item.savedId) return false // can not save global store until item itself has been saved
      return !!hiddenItemsByName.get('global_store_' + _item.savedId)?.saving
    }
    get saved_id(): number {
      return item(this.id).savedId
    }
    get editing(): boolean {
      return item(this.id).editing
    }
    get editable(): boolean {
      return item(this.id).editable
    }
    set editable(editable: boolean) {
      const _item = item(this.id)
      if (_item.editable != editable) {
        _item.editable = editable
        items = items // trigger svelte render
      }
      // also update & save in attr, but async to allow changes to be combined/batched
      this._update_attr_async('editable')
    }

    get pushable(): boolean {
      return item(this.id).pushable
    }
    set pushable(pushable: boolean) {
      const _item = item(this.id)
      if (_item.pushable != pushable) {
        _item.pushable = pushable
        lastEditorChangeTime = 0 // disable debounce even if editor focused
        onEditorChange(editorText) // trigger re-ranking since pushability can affect it
      }
      // also update & save in attr, but async to allow changes to be combined/batched
      this._update_attr_async('pushable')
    }

    get shared(): object {
      return item(this.id).shared
    }

    // share item under key (unique at user level) at index (or no index if hidden)
    share(key, index) {
      if (!key) throw new Error('sharing key is required')
      // note besides alphanumeric characters we only allow dashes since those are also ok in tag names
      if (typeof key !== 'string' || !key.match(/^[\w-]+$/)) throw new Error('sharing key must be alphanumeric string')
      if (key.length > 128) throw new Error('sharing key too long (>128 chars)')
      if (index !== undefined)
        if (!Number.isInteger(index) || index < 0) throw new Error('sharing index must be integer >= 0')
      const _item = item(this.id)
      _item.shared ??= {}
      _item.shared.keys ??= []
      if (!_item.shared.keys.includes(key)) _item.shared.keys.push(key)
      if (index !== undefined) {
        _item.shared.indices ??= {}
        _item.shared.indices[key] = index
      }
      // also update & save in attr, but async to allow changes to be combined/batched
      this._update_attr_async('shared')
    }

    // unshare item under key (unique at user level)
    unshare(key) {
      if (!key) throw new Error('sharing key is required')
      if (typeof key !== 'string') throw new Error('sharing key must be string')
      const _item = item(this.id)
      if (!_item.shared?.keys) return
      _.pull(_item.shared.keys, key)
      delete _item.shared.indices?.[key]
      if (_.isEmpty(_item.shared.indices)) delete _item.shared.indices // for consistency w/ share
      if (!_item.shared.keys.length) _item.shared = null // no longer shared
      // also update & save in attr, but async to allow changes to be combined/batched
      this._update_attr_async('shared')
    }

    // dispatch task to update to this.attr[prop] iff it differs from this[prop]
    // note dispatch allows changes to be combined, batched, cancel out, etc
    // note changes can happen in both directions, e.g. remote changes to this.attr[prop] -> this[prop]
    _update_attr_async(prop) {
      this.dispatch_task('_update_attr_async.' + prop, () => {
        if (!_exists(this.id)) return // item deleted, just cancel
        const _item = item(this.id)
        _item.attr ??= {}
        if (!_.isEqual(_item.attr[prop], this[prop])) {
          _item.attr[prop] = _.cloneDeep(this[prop])
          itemAttrChanged(this.id, false /* remote */) // invoke _on_attr_change on item or listeners
          this.save()
        }
      })
    }

    get elem(): HTMLElement {
      // NOTE: we return the super-container as it is available even when editing
      // return document.getElementById("item-" + this.id);
      return document.getElementById('super-container-' + this.id)
    }

    // default log options for write_log, reset in each eval w/ 'run' trigger
    get log_options(): object {
      const _item = item(this.id)
      return (_item.log_options ??= {})
    }

    // general-purpose key-value store with session/item lifetime
    get store(): object {
      let _item = item(this.id)
      return (_item.store ??= {})
    }

    set store(obj: object) {
      if (Object.getPrototypeOf(obj) != Object.prototype)
        throw new Error('attempt to set item.store to non-plain-object')
      item(this.id).store = obj
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
    // asynchronous changes must be saved manually via save_local_store
    get local_store(): object {
      this.save_local_store()
      return this._local_store
    }

    set local_store(obj: object) {
      if (Object.getPrototypeOf(obj) != Object.prototype)
        throw new Error('attempt to set item.local_store to non-plain-object')
      this.save_local_store()
      item(this.id).local_store = obj
    }

    // direct local_store accessor w/o auto-save for sync changes
    // any changes must be saved manually via save_local_store
    get _local_store(): object {
      let _item = item(this.id)
      // until item is saved, we can only initialize and return in-memory store
      if (!_item.savedId) return (_item.local_store ??= {})
      const key = 'mindpage_item_store_' + _item.savedId
      _item.local_store ??= JSON.parse(localStorage.getItem(key)) || {}
      return _item.local_store
    }

    // saves item.local_store to localStorage
    // removes from localStorage if item or item.local_store is missing, or if object is empty
    // saving changes to local_store triggers re-render in case rendering is affected
    // always dispatched as a task with configurable delay (default 0)
    save_local_store({ delay = 0, invalidate_elem_cache = true, force_render = true, render_delay = 1000 } = {}) {
      this.dispatch_task(
        'save_local_store',
        () => {
          let __item = item(this.id)
          // retry every second until item is saved
          if (!__item.savedId) {
            this.save_local_store({ delay: 1000, invalidate_elem_cache, force_render, render_delay })
            return
          }
          const key = 'mindpage_item_store_' + __item.savedId
          const modified = !_.isEqual(__item.local_store, JSON.parse(localStorage.getItem(key)) || {})
          if (modified && invalidate_elem_cache) this.invalidate_elem_cache({ force_render, render_delay })
          if (_.isEmpty(__item.local_store)) localStorage.removeItem(key)
          else if (modified) localStorage.setItem(key, JSON.stringify(__item.local_store))

          // if modified, invoke _on_local_store_change(id) on all listener (or self) items
          if (modified) {
            items.forEach(item => {
              if (!item.listen && item.id != this.id) return // must be listener or self
              if (!itemDefinesFunction(item, '_on_local_store_change')) return
              Promise.resolve(
                _item(item.id).eval(`_on_local_store_change('${this.id}')`, {
                  trigger: item.listen ? 'listen' : 'change',
                  async: item.deepasync, // run async if item is async or has async deps
                  async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
                })
              ).catch(e => {}) // already logged
            })
          }
        },
        delay
      )
    }

    // "global" key-value store backed by firebase via hidden items named "global_store_<id>"
    // dispatches call to save_global_store to auto-save any synchronous changes
    // e.g. item.global_store.hello = "hello world" // saved automatically
    // asynchronous changes must be saved manually via save_local_store
    // redirects to local_store._anonymous_global_store for anonymous user
    get global_store(): object {
      this.save_global_store()
      return this._global_store
    }

    set global_store(obj: object) {
      if (Object.getPrototypeOf(obj) != Object.prototype)
        throw new Error('attempt to set item.global_store to non-plain-object')
      this.save_global_store()
      item(this.id).global_store = obj
    }

    // direct global_store accessor w/o auto-save for sync changes
    // any changes must be saved manually via save_global_store
    get _global_store(): object {
      let _item = item(this.id)
      // until item is saved, we can only initialize and return in-memory store
      if (!_item.savedId) return (_item.global_store ??= {})
      if (anonymous) {
        _item.global_store ??= _.cloneDeep(this.local_store['_anonymous_global_store']) || {}
      } else {
        const name = 'global_store_' + _item.savedId
        _item.global_store ??= _.cloneDeep(hiddenItemsByName.get(name)?.item) || {}
      }
      return _item.global_store
    }

    // saves item.global_store to firebase
    // deletes from firebase if item or item.global_store is missing, or if object is empty
    // saving changes to global_store triggers re-render in case rendering is affected
    // always dispatched as a task with configurable delay (default 0)
    // redirects to save_local_store() for anonymous user
    save_global_store({ delay = 0, invalidate_elem_cache = true, force_render = true, render_delay = 1000 } = {}) {
      this.dispatch_task(
        'save_global_store',
        () => {
          let __item = item(this.id)
          // retry every second until item is saved
          if (!__item.savedId) {
            this.save_global_store({ delay: 1000, invalidate_elem_cache, force_render, render_delay })
            return
          }
          let modified = false
          if (anonymous) {
            // emulate global store using local store
            modified = !_.isEqual(__item.global_store, this.local_store['_anonymous_global_store'] || {})
            if (modified && invalidate_elem_cache) this.invalidate_elem_cache({ force_render, render_delay })
            if (_.isEmpty(__item.global_store)) delete this.local_store['_anonymous_global_store']
            else if (modified) this.local_store['_anonymous_global_store'] = _.cloneDeep(__item.global_store)
          } else {
            const name = 'global_store_' + __item.savedId
            modified = !_.isEqual(__item.global_store, hiddenItemsByName.get(name)?.item || {})
            if (modified && invalidate_elem_cache) this.invalidate_elem_cache({ force_render, render_delay })
            if (_.isEmpty(__item.global_store)) deleteHiddenItem(hiddenItemsByName.get(name)?.id)
            else if (modified) saveHiddenItem(name, _.cloneDeep(__item.global_store))
          }

          // if modified, invoke _on_global_store_change(id, false) on all listener (or self) items
          if (modified) {
            items.forEach(item => {
              if (!item.listen && item.id != this.id) return // must be listener or self
              if (!itemDefinesFunction(item, '_on_global_store_change')) return
              Promise.resolve(
                _item(item.id).eval(`_on_global_store_change('${this.id}',false)`, {
                  trigger: item.listen ? 'listen' : 'change',
                  async: item.deepasync, // run async if item is async or has async deps
                  async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
                })
              ).catch(e => {}) // already logged
            })
          }
        },
        delay
      )
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
          const dep = _item(id)
          // NOTE: we allow async dependencies to be excluded so that "sync" items can still depend on async items for auto-updating or non-code content or to serve as a mix of sync/async items that can be selectively imported
          if (options['exclude_async_deps'] && dep.deepasync) return // exclude async dependency chain
          // indicate dependency name in comments for certain types of reads
          if (type.match(/^(?:js|webppl)(?:_|$)/)) content.push(`/* ${type} @ ${dep.name} */`)
          else if (type.match(/^(?:html)(?:_|$)/)) content.push(`<!-- ${type} @ ${dep.name} -->`)
          content.push(dep.read(type, options))
        })
      }

      // exclude async content (and return early) if requested
      if (options['exclude_async'] && item.deepasync) return content.filter(s => s).join('\n')

      // read text from specified block type (or whole item if type is blank)
      let text = type ? extractBlock(item.text, type, options['remove_empty_lines']) : item.text

      // evaluate <<macros>> if requested (logic mirrors that in Item.svelte)
      if (options['eval_macros']) {
        // note the reset conditions here (deephash, version, etc) should match those in toHTML in Item.svelte
        if (
          item.expanded &&
          !item.expanded.error &&
          item.expanded.deephash == item.deephash &&
          item.expanded.version == item.version
        ) {
          text = item.expanded.text // use prior expansion
        } else {
          item.expanded = {} // reset macro expansion state
          let cacheIndex = 0
          const replaceMacro = (m, js) => {
            if (!isBalanced(js)) return m // skip unbalanced macros that are probably not macros, e.g. ((x << 2) >> 2)
            try {
              return this.eval(js, {
                trigger: 'macro_' + cacheIndex++,
                cid: `${this.id}-${this.deephash}-${cacheIndex}`, // enable replacement of $cid
              })
            } catch (e) {
              item.expanded.error = e
              console.error(`macro error in item ${this.label || 'id:' + this.id}: ${e}`)
              throw e // stop read and throw error
            }
          }
          item.expanded.text = text = text.replace(/<<(.*?)>>/g, skipEscaped(replaceMacro))
          item.expanded.deephash = item.deephash
          item.expanded.version = item.version
          item.expanded.count = cacheIndex
          itemExpansionChanged(item)
        }
      }

      // replace $ids if requested
      if (options['replace_ids']) text = text.replace(/\$id/g, skipEscaped(item.id))

      // remove empty lines if requested
      if (options['remove_empty_lines']) text = text.replace(/(^|\n)\s*(?:\n|$)/g, '$1').trim() // trim for last \n

      // remove comment lines if requested (for js type only for now)
      if (options['remove_comment_lines'] && type.match(/^(?:js)(?:_|$)/))
        text = text.replace(/(^|\n)(?:\s*\/\/.*?(?:\n|$))+/g, '$1').trim() // trim for last \n

      // remove tests & benchmarks if requested (for js type only for now)
      if (options['remove_tests_and_benchmarks'] && type.match(/^(?:js)(?:_|$)/)) {
        // simple regex matches top-level definitions w/ closing brace on new line; prior comments also removed following same regex in mind.items/util/core.js
        text = text.replace(
          /(?:^|\n)(?:(?:\/\/[^\n]*?\n)*)(?:async function|function|const|let) +(?:_test_|_benchmark_)\w+ *=? *\(.*?\) *(?:=>)? *\{.*?\n\}/gs,
          ''
        )
        // also remove function name definitions, assuming flat array form; prior comments also removed following same regex in mind.items/util/core.js
        text = text.replace(
          /(?:^|\n)(?:(?:\/\/[^\n]*?\n)*)(?:const|let) +(?:_test_|_benchmark_)\w+_functions *=? *\[.*?\] *;? */gs,
          ''
        )
      }

      // remove hidden|removed sections if requested (whole item reads only)
      // includes hidden|removed markdown blocks or html sections (via delimiter comments)
      if (options['remove_hidden'] && !type) {
        text = text.replace(blockRegExp('.*_hidden *'), '')
        text = text.replace(/<\!--\s*hidden\s*-->(.*?)<!--\s*\/hidden\s*-->\s*?(\n|$)/gs, '')
      }
      if (options['remove_removed'] && !type) {
        text = text.replace(blockRegExp('.*_removed *'), '')
        text = text.replace(/<\!--\s*removed\s*-->(.*?)<!--\s*\/removed\s*-->\s*?(\n|$)/gs, '')
      }

      // remove specific blocks if requested (whole item reads only)
      if (options['remove_blocks'] && !type) text = text.replace(blockRegExp(options['remove_blocks']), '')

      content.push(text)
      // console.debug(content)
      return content.filter(s => s).join('\n')
    }

    // "deep read" function with include_deps=true as default
    read_deep(type: string, options: object = {}) {
      if (!type) throw new Error('read_deep requires block type')
      return this.read(type, Object.assign({ include_deps: true }, options))
    }

    // read function intended for reading *_input code blocks with prefix from dependents
    // default options are modified (see below) as appropriate for reading code
    read_input(type: string, options: object = {}) {
      if (!type) throw new Error('read_input requires block type')
      const read_options = Object.assign(
        {
          replace_ids: true,
          remove_empty_lines: true,
          remove_comment_lines: true,
          remove_tests_and_benchmarks: true,
        },
        options
      )
      return [this.read_deep(type, read_options), this.read(type + '_input', read_options)].join('\n')
    }

    // accessor for console log associated with item
    // levels are listed below, default level ("info") excludes debug messages
    // since can be "eval" (default), "run", or any epoch time (same as Date.now)
    // source can be "self" (default), specific item name (label or id), or "any"
    // if source is suffixed with '?', then lines w/ empty stack are included
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
      let name = options['source'] || 'self'
      let allow_empty_stack = false
      if (name.endsWith('?')) {
        name = name.slice(0, -1)
        allow_empty_stack = true
      }
      if (name != 'self' && name != 'any' && !_item(name, { silent: true })) {
        console.error(`get_log: unknown source '${name}'`)
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

      const filter_id = name == 'self' ? this.id : name == 'any' ? '' : _item(name, { silent: true }).id
      for (let i = consoleLog.length - 1; i >= 0; --i) {
        const entry = consoleLog[i]
        if (entry.time < since) break
        if (entry.level < level) continue
        if (filter_id && (!allow_empty_stack || entry.stack.length > 0) && !entry.stack.includes(filter_id)) continue
        if (filter && !filter(entry)) continue
        let prefix = entry.type == 'log' ? '' : entry.type.toUpperCase() + ': '
        if (prefix == 'WARN: ') prefix = 'WARNING: '
        log.push(prefix + entry.text)
      }
      return log.reverse()
    }

    write(text: string, type: string = '_output', options = {}) {
      if (this.read_only) {
        console.warn(`ignoring write (${text.length} bytes, type '${type}') to item ${this.name} in read_only mode`)
        return
      }
      text = typeof text == 'string' ? text : '' + stringify(text)
      // confirm if write is too big
      const writeConfirmLength = 256 * 1024
      if (text.length >= writeConfirmLength) {
        if (!confirm(`Write ${text.length} bytes (type '${type}') into ${this.name}?`)) return // cancel write
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

      let __item = item(this.id) // writeable item
      if (type.endsWith('_log')) {
        // if writing a *_log block, remove any existing *_log blocks, and only write if non-empty
        // note this forces all logs to be consolidated at bottom, allowing collapsing (currently for _log only)
        __item.text = removeBlock(this.text, '\\w*?_log') // remove existing *_log
        if (text) __item.text = appendBlock(this.text, type, text) // if empty, skip
      } else if (type.trim()) {
        // if writing a non-log block and a non-empty _log block exists, move it to bottom
        __item.text = appendBlock(this.text, type, text)
        const _log = extractBlock(this.text, '_log')
        if (_log) {
          __item.text = removeBlock(this.text, '_log')
          __item.text = appendBlock(this.text, '_log', _log)
        }
      } else {
        // replace whole item
        __item.text = text
      }

      if (!__item.log && !options['keep_time']) __item.time = Date.now()

      // trigger save first to put item in saving state (prevents unnecessary edit cancel confirmation)
      // if (!item(this.id)?.editing) saveItem(this.id);
      // console.debug('saving after write', this.name, { text, type, options })
      if (!options['skip_save']) saveItem(this.id)
      items = items // trigger svelte render to reflect saving state
      tick().then(() => {
        // update all other item state (including dependents)
        // note this can be slow on items with many dependents, e.g. #util/core
        itemTextChanged(this.index, this.text, true /*update_deps*/, true /*run_deps*/, options['keep_time'])

        // invalidate element cache & force render even if text/deephash/html unchanged because writing to an item is a non-trivial operation that may be accompanied w/ external changes not captured in deephash (e.g. document-level css, highlight.js plugins, etc)
        this.invalidate_elem_cache({ force_render: true })

        // update ranking/etc via onEditorChange, dispatched to prevent index changes during eval
        setTimeout(() => {
          lastEditorChangeTime = 0 // disable debounce even if editor focused
          onEditorChange(editorText) // item time/text has changed
        })
      })
    }

    clear(type: string, options) {
      if (!type) throw new Error('clear(type) requires block type')
      this.write(clearBlock(this.text, type), '', options)
    }

    remove(type: string, options) {
      if (!type) throw new Error('remove(type) requires block type')
      this.write(removeBlock(this.text, type), '', options)
    }

    // deletes item
    // may be subject to confirmation unless confirm=false
    // returns true if deleted, false if declined/cancelled
    delete(confirm) {
      return deleteItem(this.index, confirm)
    }

    write_log(options) {
      options = _.merge(
        {
          since: 'eval',
          level: 'info',
          type: '_log',
          source: 'self?',
        },
        item(this.id).log_options, // may be undefined
        options
      )
      // write only if log differs from existing block in item
      const log = this.get_log(options).join('\n')
      if (this.read(options['type']) != log) this.write(log, options['type'], options)
      if (options['type'] == '_log' || options['show_logs']) this.show_logs()
    }

    show_logs(autohide_after: number = 15000) {
      itemShowLogs(this.id, autohide_after)
    }

    get status(): string {
      const statusdiv = this.elem?.querySelector('.container.running > .loading > .status')
      return statusdiv?.innerHTML ?? null
    }

    set status(status: string) {
      this.dispatch_task('set_status', () => {
        const statusdiv = this.elem?.querySelector('.container.running > .loading > .status')
        if (!statusdiv) return
        // retry later if there is a selection
        if (
          getSelection().type == 'Range' &&
          (statusdiv.contains(getSelection().anchorNode) || statusdiv.contains(getSelection().focusNode))
        )
          return 1000 // retry in 1s
        statusdiv.innerHTML = status
      })
    }

    get progress(): number {
      const statusdiv = this.elem?.querySelector('.container.running > .loading > .status')
      const progress = statusdiv?.getAttribute('data-progress')
      return !progress ? null : parseFloat(progress)
    }

    set progress(progress: number) {
      if (progress < 0 || progress > 1) throw new Error('invalid progress ' + progress)
      const statusdiv = this.elem?.querySelector('.container.running > .loading > .status') as HTMLDivElement
      if (!statusdiv) return
      const percentage = (progress * 100).toFixed(3) + '%'
      statusdiv.style.background = `linear-gradient(90deg, #136 ${percentage}, #013 ${percentage})`
      statusdiv.setAttribute('data-progress', progress.toString())
    }

    show_status(status, progress) {
      if (status) this.status = status
      if (progress) this.progress = progress
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
      // initialize items if not already done (usually due to macros at first render)
      // note should no longer be needed since initialize invokes initItems before renderRange
      // initItems()
      if (!itemInitTime) throw new Error('eval before initItems')

      // throw error if there are missing dependencies
      // _direct_ missing dependencies should be already indicated visibly
      // macros should be re-run as soon as missing dependencies are installed/restored
      const missing_deps = []
      itemDeps(this.index, [], missing_deps)
      if (missing_deps.length > 0)
        throw new Error('missing dependencies: ' + missing_deps.map(t => t.slice(1)).join(', '))

      // set up options used to read prefix below
      // used both to read prefix for eval, and to read items returned by eval macros
      const prefix_read_options = Object.assign(
        {
          // async deps are excluded by default, i.e. unless async:true in options
          // this affects ALL default eval, including e.g. 'macro_*' evals (see Item.svelte)
          // notable exceptions are async runs, commands, listeners, etc
          exclude_async_deps: !options['async'],
          // other options are same as used to read prefix in read_input
          replace_ids: true,
          remove_empty_lines: true,
          remove_comment_lines: true,
          remove_tests_and_benchmarks: true,
        },
        options
      )

      // no wrapping or context prefix in debug mode (since already self-contained and wrapped)
      if (!options['debug']) {
        // remove comment lines
        evaljs = evaljs.replace(/(^|\n)(?:\s*\/\/.*?(?:\n|$))+/g, '$1').trim() // trim for last \n

        // apply _returning_ wrapper for evaljs for additional scoping
        // this is an inner wrapper that excludes any context prefix (see below for outer wrapper)
        // we attempt to insert return to last returnable (+balanced) expression to maintain ~eval semantics
        // NOTE: we can be conservative about returns since can be added manually if missed here

        const expr_returnable = expr =>
          // check for reserved keywords, see https://www.w3schools.com/js/js_reserved.asp
          // NOTE: we include ALL reserved words except true|false|null|undefined|new|this|await|eval|typeof which are obviously sensible
          // NOTE: some of these keywords passed the variable name test ("let X = 0"), but we include them anyway; these were: (abstract|await|boolean|byte|char|double|final|float|goto|int|long|native|short|synchronized|throws|transient|volatile)
          // NOTE: any variable can still be returned by wrapping in parentheses, e.g. (goto)
          !expr.match(
            /^(?:\s*[})\].,:]|(?:abstract|arguments|boolean|break|byte|case|catch|char|class|const|continue|debugger|default|delete|do|double|else|enum|export|extends|final|finally|float|for|function|goto|if|implements|import|in|instanceof|int|interface|let|long|native|package|private|protected|public|return|short|static|super|switch|synchronized|throw|throws|transient|try|var|void|volatile|while|with|yield)(?:\W|$))/
          )

        // do not insert return if js ends with a semicolon
        if (!evaljs.match(/;\s*$/)) {
          // first try to insert return at partial-line (semicolon) level ...
          // regex looks for last semicolon OR _unindented_ new line OR whole js code block
          // regex takes any whitespace into prefix so it does not split return statement
          // then we check expression for being balanced+returnable
          let try_lines // try full lines below?
          evaljs = evaljs.replace(/(.*(?:\n(?! )|;|^)\s*)(.+?)$/s, (m, pfx, expr) => {
            if (!isBalanced(expr)) {
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
                if (!isBalanced(expr)) try_last_line('' + pfx, '' + expr)
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
          let prefix = this.read_deep(options['type'] || 'js', prefix_read_options)
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
        evaljs = [
          "'use strict';undefined;",
          `const _id = '${this.id}';`,
          // overload window._item for read_only access to item itself (e.g. via _this) in lexical scope
          !options['read_only'] ? [] : ['const _item = (n,s,ro) => window._item(n,s,ro,_id);'],
          'const _this = _item(_id);',
          evaljs,
        ]
          .flat()
          .join('\n')
      }

      // evaluate inline @{eval_macros}@
      let macroIndex = 0
      const replaceMacro = (m, js) => {
        if (!isBalanced(js)) return m // skip unbalanced macros that are probably not macros, e.g. ((x @{ 2) }@ 2)
        try {
          let out = this.eval(js, {
            trigger: 'eval_macro_' + macroIndex++,
            exclude_prefix: true /* avoid infinite recursion */,
          })
          // if output is an item, read(*_macro) by default, where * is the prefix type
          // (using _macro suffix allows item to be a dependency without importing same code as prefix)
          // read options are same as those used to read prefix above
          if (out instanceof _Item) out = out.read_deep((options['type'] || 'js') + '_macro', prefix_read_options)
          return out
        } catch (e) {
          console.error(`eval_macro error in item ${this.label || 'id:' + this.id}: ${e}`)
          throw e // stop eval and throw error
        }
      }
      // evaljs = evaljs.replace(/<<(.*?)>>/g, skipEscaped(replaceMacro));
      evaljs = evaljs.replace(/@\{(.*?)\}@/g, skipEscaped(replaceMacro))

      // replace any remaining $id, $hash, $deephash, just like in _html(_*) blocks in Item.svelte
      evaljs = evaljs.replace(/\$id/g, skipEscaped(this.id))
      evaljs = evaljs.replace(/\$hash/g, skipEscaped(this.hash))
      evaljs = evaljs.replace(/\$deephash/g, skipEscaped(this.deephash))
      if (options['cid']) evaljs = evaljs.replace(/\$cid/g, skipEscaped(options['cid']))

      // if skipping eval, just return the js code
      if (options['skip_eval']) return evaljs

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
    // item may not be on stack unless added explicitly (see below)
    // log messages are NOT associated with item while it is off the stack
    // _this is still defined in lexical context as if item is top of stack
    // returns promise resolved/rejected once evaluation is done (w/ output) or triggers error
    start(async_func, log_options) {
      log_options = _.merge({ since: Date.now() }, log_options) // set default 'since' for write_log below
      item(this.id).running = true
      return update_dom().then(() =>
        this.resolve(async_func())
          .then(output => {
            if (output !== undefined) this.write(output)
            return output
          })
          .catch(e => {
            console.error(e)
            this.invalidate_elem_cache()
          })
          .finally(() => {
            this.write_log(log_options) // can also be customized via _this.log_options
            item(this.id).running = false
          })
      )
    }

    // invokes given (sync or async) function after pushing item onto stack
    // re-returns any return value, rethrows (after logging) any errors
    invoke(func) {
      evalStack.push(this.id)
      try {
        let out = func()
        // if function returns promise, attach it and set up default rejection handler
        // note rethrowing errors triggers outer try/catch block via _separate_ invoke wrapper (see onRejected below)
        if (out instanceof Promise)
          out = this.attach(out).catch(e => {
            throw e // handled & rethrown in outer catch block
          })
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
    // note function is invoked even if item is deleted before timeout
    dispatch(func, delay_ms = 0) {
      return setTimeout(this.attach(func), delay_ms)
    }

    // dispatches function as a named task that can be cancelled or repeated
    // if repeat_ms>=0, repeats function as long as item is not deleted
    // cancels any previously dispatched task under given name
    // cancels task if function returns null or throws error
    // cancels task (w/o invoking function) if item is deleted
    // modifies repeat_ms (once) if function returns number>=0
    // function can be async or return promise
    dispatch_task(name, func, delay_ms = 0, repeat_ms = -1) {
      const task = () => {
        if (!_exists(this.id)) return // item deleted
        const _item = item(this.id)
        if (_item.tasks[name] != task) return // task cancelled or replaced
        _item.running_tasks ??= {}
        _item.running_tasks[name] = this.resolve(_item.running_tasks[name]).then(() => {
          if (_item.tasks[name] != task) return // task cancelled or replaced
          try {
            this.resolve(func())
              .then(out => {
                if (out === null) {
                  delete _item.tasks[name] // task cancelled!
                  return
                }
                if (out >= 0) this.dispatch(task, out) // dispatch repeat
                else if (repeat_ms >= 0) this.dispatch(task, repeat_ms) // dispatch repeat
                else delete _item.tasks[name] // task done!
              })
              .catch(e => {
                console.error(`stopping task '${name}' due to error: ${e}`)
                delete _item.tasks[name] // task finished (w/ error)!
              })
          } catch (e) {
            // handle error in sync func
            console.error(`stopping task '${name}' due to error: ${e}`)
            delete _item.tasks[name] // task finished (w/ error)!
          }
        })
      }
      const _item = item(this.id)
      _item.tasks ??= {}
      _item.tasks[name] = task // cancels/replaces any previous task under same name
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
      const stack = new Error().stack.split('\n').join(' <- ').replace(/\s+/g, ' ') // normalize whitespace
      // also log error directly to console for better stack traces (esp. in Safari, Chrome handles traces better)
      // disable this extra log message if we are testing for throws, indicated via window._testing_throws flag
      // also use _error (w/ ...args) to log only the browser console and not to mindpage console or items
      if (!window['_testing_throws']) console['_error']('[error @' + this.name + ']', ...args)
      throw new Error(`${args.join(' ')} @ ${this.name}; STACK: ${stack}`)
    }

    // delay = promise resolved after specified time
    delay(ms) {
      return this.promise(resolve => this.dispatch(resolve, ms))
    }

    // return array of uploaded private image srcs, urls ({output:"url"}), or blobs ({output:"blob"})
    // returns promise for urls or blobs as they require download and decryption
    // can be restricted to specified srcs if options.srcs is provided
    // other options are passed to this.read('', options)
    images(options = {}) {
      const srcs =
        options['srcs'] ??
        _.uniq(
          Array.from(
            (
              this.read('', options)
                .replace(/(?:^|\n) *```(\S*).*?\n *```/gs, (m, type) => {
                  if (type.match(/^(?:_html|_md|_markdown)(?:_|$)/)) return m // keep embeds
                  return ''
                }) // remove multi-line blocks (except embedded _html|_md|_markdown blocks)
                // NOTE: currently we miss indented blocks that start with bullets (since it requires context)
                .replace(/(?:^|\n)     *[^-*+ ].*(?:$|\n)/g, '') // remove 4-space indented blocks
                .replace(
                  /`.*?`/g,
                  skipEscaped('') // remove inline code spans
                ) as any
            ).matchAll(/<img\s(?:"[^"]*"|[^>"])*?src\s*=\s*"([^"]*)"(?:"[^"]*"|[^>"])*>/gi),
            m => m[1]
          ).map(src =>
            src.replace(/^https?:\/\/www\.dropbox\.com/, 'https://dl.dropboxusercontent.com').replace(/\?dl=0$/, '')
          )
        ).filter(src => src.match(new RegExp('^(?:' + user.uid + '\\/images\\/)?[0-9a-fA-F]+$')))
      const output = options['output'] || 'src'
      if (!['src', 'url', 'blob'].includes(output)) {
        console.error(`images: invalid output '${output}', should be src, url, or blob`)
        return srcs
      }
      if (output == 'src') return srcs
      return Promise.all(
        srcs.map(src => {
          // prefix <uid>/images/ automatically for hex src
          if (src.match(/^[0-9a-fA-F]+$/)) src = user.uid + '/images/' + src
          const start = Date.now()
          if (images[src]) {
            const url = images[src]
            return output == 'url' ? url : fetch(url).then(r => r.blob()) // local fetch should be fast
          }
          return getBlob(ref(getStorage(firebase), src)).then(blob => {
            if (src.startsWith('anonymous/') || src.startsWith(`${sharer}/uploads/public/images/`)) {
              // user is anonymous OR image is public, so we can use blob as is ...
              console.debug(
                `downloaded unencrypted image ${src} (${blob.type}, ${blob.size} bytes) in ${Date.now() - start}ms`
              )
              return output == 'blob' ? blob : (images[src] = URL.createObjectURL(blob))
            } else {
              // we need to decrypt the image blob using personal secret ...
              return blob.arrayBuffer().then(buffer => {
                const decrypt_start = Date.now()
                return decrypt_bytes(new Uint8Array(buffer)).then((array: Uint8Array) => {
                  let type = blob.type
                  if (type == 'application/octet-stream') {
                    // image type is prefixed (older images only)
                    type = byteArrayToString(array.subarray(0, array.indexOf(';'.charCodeAt(0))))
                    array = array.subarray(array.indexOf(';'.charCodeAt(0)) + 1)
                  }
                  blob = new Blob([array], { type }) // decrypted blob
                  console.debug(
                    `downloaded encrypted image ${src} (${type}, ${array.length} bytes) in ${Date.now() - start}ms ` +
                      `(decryption took ${Date.now() - decrypt_start}ms)`
                  )
                  return output == 'blob' ? blob : (images[src] = URL.createObjectURL(blob))
                })
              })
            }
          })
        })
      )
    }

    // invalidates element cache for item
    // often invoked from error handling code
    // otherwise can force re-render even if deephash/html are unchanged
    // note forced re-render also forces re-eval of macros at re-render time
    // delayed to prevent accidental tight render<->trigger loops that could crash browser
    invalidate_elem_cache({ force_render = false, render_delay = 1000 } = {}) {
      this.dispatch_task(
        'invalidate_elem_cache',
        () => {
          invalidateElemCache(this.id)
          if (force_render) {
            item(this.id).version++
            items = items // trigger svelte render
          }
        },
        render_delay
      )
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

  function scrollTo(y) {
    // NOTE: we have to add (innerHeight * visualViewport.scale - document.body.offsetHeight) on ios
    //       likely related to inconsistency of innerHeight vs visualViewport.height on ios
    //       otherwise causes scrolling to be off by up to virtual keyboard height
    //       this delta seems to be zero on other devices (including android)
    document.body.scrollTo(0, y + innerHeight * visualViewport.scale - document.body.offsetHeight)
    // console.trace()
  }

  let padding = 0
  let lastViewHeight = 0
  function updateVerticalPadding(skip_scroll = false) {
    if (ios) return // disabled on ios due to scrolling inconsistencies before/after focus (i.e. virtual keyboard)
    if (!itemsdiv) return
    // replace "vh" units with "px" which is better supported on android (and presumably elsewhere also)
    // in particular on android "vh" units can cause jitter or flicker during scrolling tall views
    // as a nice side effect this ensures header stays in view (precisely) on ios
    // we use visualViewport.height since it is also used for scrolling
    // note viewport height can change frequently, e.g. for virtual keyboards
    const viewHeight = visualViewport.height * visualViewport.scale
    if (viewHeight == lastViewHeight) return
    // console.debug(`updating vertical padding for new height ${viewHeight} != ${lastViewHeight}`)
    const prevScrollTop = document.body.scrollTop
    const prevPadding = itemsdiv.querySelector('.column-padding').offsetHeight
    padding = 0.7 * viewHeight
    // console.debug(`updating vertical padding to ${padding} for viewHeight ${viewHeight}, was ${lastViewHeight}`)
    // padding += Math.max(0, 20 - (prevScrollTop + padding - prevPadding))
    itemsdiv.querySelectorAll('.column-padding').forEach((div: HTMLElement) => (div.style.height = padding + 'px'))
    // adjust bottom padding and then scroll position to prevent jumping
    itemsdiv.style.paddingBottom = padding + 'px'
    lastViewHeight = viewHeight
    if (!skip_scroll) scrollTo(prevScrollTop + padding - prevPadding)
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
  let defaultItemHeight = 0 // if zero, initial layout will be single-column
  let totalItemHeight = 0
  let lastFocusedEditElement = null
  let disableScrollingOnLayout = false
  let lastLayoutTime = 0
  let lastLayoutCount = 0
  let layoutScrollDispatchTime = 0
  let showDotted = false
  const separatorHeight = 80

  function updateItemLayout() {
    // NOTE: first layout is via checkLayout w/ 0 items, 0 height
    //       second is via initialize -> onEditorChange w/ >0 items, 0 height
    //       subsequent layouts are via onItemResized -> tryLayout w/ >0 items, >0 height
    // console.debug('updateItemLayout', items.length, _.sum(items.map(item => item.height)))
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
    lastLayoutTime = Date.now()
    lastLayoutCount++
    // showDotted = false; // auto-hide dotted
    resizeHiddenColumn()
    updateVerticalPadding()

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
      if (!fixed && !item.pinned && (index == 0 || timeString != lastTimeString)) {
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
          columnHeights[lastColumn] + item.outerHeight + separatorHeight <= minColumnHeight + 0.9 * outerHeight
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
          columnHeights[lastColumn] += separatorHeight // .section-separator height including margins
        }
      }
      // mark item as aboveFold if it is pinned or item is visible (at least partially) on first screen
      // if item heights are not available, then we use item index in column and assume top 5 are above fold
      item.aboveFold =
        item.pinned || (item.height ? columnHeights[item.column] < outerHeight : columnItemCount[item.column] < 5)
      // if (item.aboveFold)
      //   console.debug(
      //     'aboveFold',
      //     index,
      //     item.height,
      //     columnHeights[item.column],
      //     outerHeight,
      //     columnItemCount[item.column]
      //   )
      // // item "prominence" i position in screen heights, always 0 if pinned, 1+ if !aboveFold
      // item.prominence = item.pinned
      //   ? 0
      //   : totalItemHeight > 0
      //   ? columnHeights[item.column] / outerHeight
      //   : columnItemCount[item.column] / 5;
      columnItemCount[item.column]++

      // mark item as "mover" if it changes index and/or column
      item.mover = item.index != item.lastIndex || item.column != item.lastColumn
      if (item.mover && index < topMovers[item.column]) topMovers[item.column] = index
      item.lastIndex = item.index
      item.lastColumn = item.column

      // if non-pinned item is first in its column or section and missing time string, add it now
      // also mark it as a "leader" for styling its index number
      item.leader = !item.pinned && (columnLastItem[item.column] < 0 || item.column != lastItem.column)
      if (!fixed && item.leader && !item.timeString) {
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

    checkIfRenderingVisibleItems()

    // as soon as header is available, scroll down to header and set flag
    if (headerdiv && !headerScrolled) {
      scrollTo(headerdiv.offsetTop)
      headerScrolled = true
    }

    // maintain focus and scroll to caret if edit element (textarea) changes (due to new focus or switched column)
    // OR scroll up to top mover (if not narrating, since then we prefer manual scroll)
    let activeEditItem
    if (focusedItem >= 0) {
      const div = document.querySelector('#super-container-' + items[focusedItem].id) as HTMLElement
      if (!div) console.warn('focusedItem missing on page')
      else if (!div.contains(document.activeElement)) console.warn('focusedItem does not contain activeElement')
      else activeEditItem = items[focusedItem].id
    }

    if (disableScrollingOnLayout) return
    const dispatchTime = Date.now()
    layoutScrollDispatchTime ||= dispatchTime // keep scroll dispatch time until cleared below
    const lastLayoutCountAtDispatch = lastLayoutCount
    const numItemsAtDispatch = items.length
    update_dom().then(() => {
      if (lastLayoutCount != lastLayoutCountAtDispatch) return // layout changed since dispatch
      if (items.length != numItemsAtDispatch)
        console.warn('number of items changed unexpectedly!', items.length, numItemsAtDispatch)

      const focusedEditElement = activeEditItem ? textArea(indexFromId.get(activeEditItem)) : null
      if (focusedEditElement && activeEditItem && !focusedEditElement.isSameNode(lastFocusedEditElement)) {
        focusedEditElement.focus()
        if (lastScrollTime < layoutScrollDispatchTime) restoreItemEditor(activeEditItem) // scroll to caret
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
        // console.debug("scrolling to itemTop", itemTop, document.body.scrollTop, topMovers.toString());
        // scroll up to item if needed, bringing it to ~upper-middle, snapping to header (if above mid-screen)
        if (itemTop < document.body.scrollTop && lastScrollTime < layoutScrollDispatchTime)
          scrollTo(Math.max(headerdiv.offsetTop, itemTop - visualViewport.height / 4))
        topMovers = new Array(columnCount).fill(items.length) // reset topMovers after scroll

        layoutScrollDispatchTime = 0 // reset scroll dispatch time used to gate scrolling above
      }
    })
  }

  let images // permanent fname to temporary url map
  let images_loading // images being loaded
  if (isClient) {
    images = window['_images'] = {}
    images_loading = window['_images_loading'] = {}
  }

  function onPastedImage(url: string, file: File, size_handler = null) {
    // note inserted images also trigger this function via Modal.svelte
    // console.debug('pasted image', url)
    const start = Date.now()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.readAsArrayBuffer(file) // returns code points <= 255
      reader.onload = e => {
        const bytes = new Uint8Array(e.target.result as ArrayBuffer)
        if (size_handler) size_handler(bytes.length)
        const file_hash = hash(bytes)
        const fname = `${user.uid}/images/${file_hash}` // short fname is just hash
        if (readonly) images[fname] = url // skip upload
        if (images[fname]) {
          resolve(file_hash)
          return
        }
        if (anonymous) {
          console.debug(`uploading image ${fname} (${bytes.length} bytes) ...`)
          uploadBytes(ref(getStorage(firebase), `${user.uid}/images/${file_hash}`), file) // mime type from file
            .then(snapshot => {
              console.debug(`uploaded image ${fname} (${bytes.length} bytes) in ${Date.now() - start}ms`)
              images[fname] = url
              resolve(file_hash)
            })
            .catch(e => {
              console.error(e)
              reject(e)
            })
        } else {
          const encrypt_start = Date.now()
          encrypt_bytes(bytes)
            .then(cipher => {
              const encrypt_time = Date.now() - encrypt_start
              console.debug(`uploading encrypted image ${fname} (${cipher.length} bytes, ${bytes.length} original) ...`)
              uploadBytes(ref(getStorage(firebase), `${user.uid}/images/${file_hash}`), cipher, {
                contentType: file.type,
              })
                .then(snapshot => {
                  console.debug(
                    `uploaded encrypted image ${fname} (${cipher.length} bytes) in ${Date.now() - start}ms ` +
                      `(encryption took ${encrypt_time}ms)`
                  )
                  images[fname] = url
                  resolve(file_hash)
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
  function onImageRendering(src: string): any {
    // drop any protocol/hostname that may have been added by browser for relative names
    const url_base = location.protocol + '//' + location.host + '/'
    if (src.startsWith(url_base)) src = src.replace(url_base, '')
    // drop existing <uid|sharer>/images/ prefix if any
    src = src.replace(new RegExp('^(?:' + user.uid + '|' + sharer + ')\\/images\\/([0-9a-fA-F]+)$'), '$1')
    // prefix <uid>/images/ automatically for hex src or (<sharer>/uploads/public/images/ in fixed/shared mode)
    if (src.match(/^[0-9a-fA-F]+$/)) {
      if (fixed) src = `${sharer}/uploads/public/images/${src}`
      else src = `${user.uid}/images/${src}`
    }
    if (
      !src.startsWith(`${user.uid}/images`) &&
      !src.startsWith('anonymous/images/') &&
      !src.startsWith(`${sharer}/uploads/public/images/`)
    )
      return { src } // external image, leave as is
    if (images[src]) return { src: images[src] } // image ready, replace src immediately
    return {
      /* transparent pixel suitable for css animation */
      src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII',
      _src: src,
      _pending: Date.now(),
    } // image pending download from _src via onImageRendered
  }

  function onImageRendered(img: HTMLImageElement) {
    // console.debug("image rendered", img.src);
    if (!img.hasAttribute('_pending')) return // nothing to do
    let src = img.getAttribute('_src')
    // prefix <uid>/images/ automatically for hex src or (<sharer>/uploads/public/images/ in fixed/shared mode)
    src = src.replace(new RegExp('^(?:' + user.uid + '|' + sharer + ')\\/images\\/([0-9a-fA-F]+)$'), '$1') // drop existing prefix
    if (src.match(/^[0-9a-fA-F]+$/)) {
      if (fixed) src = `${sharer}/uploads/public/images/${src}`
      else src = `${user.uid}/images/${src}`
    }
    if (images[src]) {
      img.src = images[src]
      img.removeAttribute('_pending') // done loading alternate _src
      return img.src // return url directly, no need to wrap in a promise
    }
    function retryIfStillPending(e) {
      // if still pending, retry after 1x time since pending (exponential backoff w/ factor >~2x)
      if (img.hasAttribute('_pending')) {
        const delay = Date.now() - parseInt(img.getAttribute('_pending'))
        console.debug(`retrying downloading image ${src} after ${delay}ms ...`)
        setTimeout(() => onImageRendered(img), delay)
      }
    }
    // if another image is loading same source, just wait for that to be done and use the same url
    if (images_loading[src]) {
      return Promise.resolve(images_loading[src])
        .then(url => {
          if (!url) throw new Error(`load failed for ${src}`)
          console.debug(`reusing loaded image ${src}`)
          img.src = url
          img.removeAttribute('_pending') // done loading alternate _src
          return img.src
        })
        .catch(retryIfStillPending) // if other load failed, we need to retry this image also
    }
    console.debug(`downloading image ${src} ...`)
    const start = Date.now()
    return (images_loading[src] = getBlob(ref(getStorage(firebase), src))
      .then(blob => {
        if (src.startsWith('anonymous/') || src.startsWith(`${sharer}/uploads/public/images/`)) {
          // user is anonymous OR image is public, so we can use blob as is ...
          console.debug(
            `downloaded unencrypted image ${src} (${blob.type}, ${blob.size} bytes) in ${Date.now() - start}ms`
          )
          img.src = URL.createObjectURL(blob)
          img.setAttribute('_type', blob.type)
          img.removeAttribute('_pending') // done loading alternate _src
          images[src] = img.src // add to cache
          return img.src
        } else {
          // we need to decrypt the image blob using personal secret ...
          return blob.arrayBuffer().then(buffer => {
            const decrypt_start = Date.now()
            return decrypt_bytes(new Uint8Array(buffer)).then((array: Uint8Array) => {
              let type = blob.type
              if (type == 'application/octet-stream') {
                // image type is prefixed (older images only)
                type = byteArrayToString(array.subarray(0, array.indexOf(';'.charCodeAt(0))))
                array = array.subarray(array.indexOf(';'.charCodeAt(0)) + 1)
              }
              blob = new Blob([array], { type }) // decrypted blob
              console.debug(
                `downloaded encrypted image ${src} (${type}, ${array.length} bytes) in ${Date.now() - start}ms ` +
                  `(decryption took ${Date.now() - decrypt_start}ms)`
              )
              img.src = URL.createObjectURL(blob)
              img.setAttribute('_type', blob.type)
              img.removeAttribute('_pending') // done loading alternate _src
              images[src] = img.src // add to cache
              return img.src
            })
          })
        }
      })
      .catch(retryIfStillPending)
      .finally(() => {
        delete images_loading[src] // no longer loading (though may retry if still pending)
      }))
  }

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
      !!tag.match(/\/pin(?:\/|$)/) ||
      specialTagFunctions.some(f => f(tag))
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
    else
      return specialTagFunctions
        .map(f => f(tag))
        .filter(Array.isArray)
        .flat()
        .filter(t => typeof t == 'string' && tagRegex.test(t))
  }

  function tagPrefixes(tag) {
    let pos
    let prefixes = []
    while ((pos = tag.lastIndexOf('/')) >= 0) prefixes.push((tag = tag.slice(0, pos)))
    return prefixes
  }

  function urlForState(state) {
    if (!initialized) return undefined // maintain url if initializing
    const text = state.editorText?.trim() || ''
    const base = location.href.replace(/#.*$/, '')
    if (text.match(/^#\S+$/) && _exists(text))
      return base + '#' + encodeURIComponent(text.slice(1)).replace(/%2F/g, '/')
    else if (text.match(/^id:\w+$/)) return base + '#' + encodeURIComponent(text.slice(3))
    else return base
  }

  function pushState(state) {
    if (state.index == 0) state.intro = true // force intro at 0 index
    history.pushState(state, state.editorText || '(clear)', urlForState(state))
    sessionStateHistory[sessionStateHistoryIndex] = history.state
    sessionStateHistory = sessionStateHistory // trigger svelte update
  }

  function replaceState(state) {
    if (state.index == 0) state.intro = true // force intro at 0 index
    history.replaceState(state, state.editorText || '(clear)', urlForState(state))
    sessionStateHistory[sessionStateHistoryIndex] = history.state
    sessionStateHistory = sessionStateHistory // trigger svelte update
  }

  // NOTE: Invoke onEditorChange only editor text and/or item content has changed.
  //       Invoke updateItemLayout directly if only item sizes have changed.
  let sessionTime = Date.now()
  let sessionStateHistory = [{ index: 0, editorText: '' }]
  let sessionStateHistoryIndex = 0
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
  let hideIndexFixed = 0
  let hideIndexMinimal = 0
  let hideIndexFromRanking = 0
  let hideIndexForSession = 0
  let renderingVisibleItems = false
  let editorChangesWithTimeKept = new Set()
  let ignoreEditorChanges = false

  function onEditorChange(text: string, keep_times = false) {
    // console.debug('onEditorChange', text, keep_times)
    if (ignoreEditorChanges) return
    editorText = text // in case invoked without setting editorText
    if (keep_times && text.trim()) editorChangesWithTimeKept.add(text.trim())
    else editorChangesWithTimeKept.clear()

    if (narrating) {
      // if non-empty editorText matches top history entry, then go back to top
      if (
        editorText.trim() &&
        sessionStateHistoryIndex > 0 &&
        editorText.trim() == sessionStateHistory[0].editorText.trim()
      ) {
        scrollToTopOnPopState = true
        history.go(-sessionStateHistoryIndex)
        return
      }

      // if non-empty editorText does not match top history entry, then end intro mode
      if (
        intro &&
        editorText.trim() &&
        sessionStateHistory[0].editorText.trim() &&
        editorText.trim() != sessionStateHistory[0].editorText.trim()
      )
        intro = false
    }

    // editor text is considered "modified" if there is a change from sessionHistory OR from history.state, which works for BOTH for debounced and non-debounced updates; this is used to enable/disable auto-hiding (hideIndex decrease) during onEditorChange
    const editorTextModified = text != sessionHistory[sessionHistoryIndex] || text != history.state.editorText

    // if editor text is cleared while a target is selected, we force new state just as in onTagClick
    if (!text.trim() && document.querySelector('.container.target')) {
      forceNewStateOnEditorChange = true // force new state
      finalizeStateOnEditorChange = true // finalize state
    }

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
          if (!itemDefinesFunction(item, '_on_change')) return
          Promise.resolve(
            _item(item.id).eval(`_on_change(\`${editorText.replace(/[`\\$]/g, '\\$&')}\`)`, {
              trigger: 'listen',
              async: item.deepasync, // run async if item is async or has async deps
              async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
            })
          ).catch(e => {}) // already logged
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
    let target
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
      listing = item.tagsVisible
        .filter(t => t != item.label)
        .slice()
        .reverse()
        .concat(item.label)
      // console.debug(listing);
    } else if (context.length == 0 && terms[0] != '#log' && idsFromLabel.get(terms[0])?.length > 1) {
      // for non-unique first-tag-matching items, still use label + prefixes as context
      let item = items[indexFromId.get(idsFromLabel.get(terms[0])[0])]
      context = [item.label].concat(item.labelPrefixes) // lower index means lower in ranking
    }

    // expand context to include "context" items that visibly tag other items in context
    // (also add their label+prefixes to context terms so they are highlighted as context as well)
    while (true) {
      const lastContextLength = context.length
      items.forEach(ctxitem => {
        if (ctxitem.index == listingItemIndex) return
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

    // restrict context to unique labels, since only unique labels are matched against context below
    context = context.filter(label => idsFromLabel.get(label)?.length == 1)

    // expand term context (tag prefixes) to include item context computed above
    termsContext = _.uniq(termsContext.concat(context))

    // parse regex terms
    const regexTerms = terms.filter(t => t.match(/^regex:\S+/)).map(t => new RegExp(t.substring(6)))

    items.forEach((item, index) => {
      textLength += item.text.length
      item.listing = index == listingItemIndex // note index != item.index at this point

      // destructure all read-only state (not read-write state) using item.expanded.item when available
      // some exceptions below (search for item.*) are id, savedId, and deps/dependentsString
      const {
        tagsVisibleExpanded,
        tagsVisible,
        label,
        labelPrefixes,
        header,
        tagsHidden,
        labelUnique,
        tagsAlt,
        lctext,
        tagsExpanded,
        text,
      } = item.expanded?.item ?? item

      // match query terms against visible tags (+prefixes) in item
      item.tagMatches = _.intersection(tagsVisibleExpanded, terms).length

      // match first term tag against visible tags (w/o prefixes)
      item.firstTagMatch = tagsVisible.includes(terms[0])

      // match query terms against item label
      item.labelMatch = !!label && terms.includes(label)

      // prefix-match first query term against item header text
      // (only for non-tags or unique labels, e.g. not #todo prefix once applied to multiple items)
      item.prefixMatch =
        header.startsWith(terms[0]) && (!terms[0].startsWith('#') || (idsFromLabel.get(terms[0]) || []).length <= 1)

      // find "pinned match" term = hidden tags containing /pin with prefix match on first term
      item.pinnedMatchTerm = tagsHidden.find(t => t.startsWith(terms[0]) && t.match(/\/pin(?:\/|$)/)) || ''
      item.pinnedMatch = item.pinnedMatchTerm.length > 0

      // set uniqueLabel for shortening code below
      // NOTE: doing this here is easier than keeping these updated in itemTextChanged
      item.uniqueLabel = labelUnique ? label : ''
      // item.uniqueLabelPrefixes = labelUnique ? labelPrefixes : [];

      // compute contextLabel as closest ancestor label from context
      item.contextLabel = !label ? '' : context.find(cl => cl.length < label.length && label.startsWith(cl)) || ''

      if (!fixed) {
        // match tags against item tagsAlt (expanded using altTags), allowing prefix matches
        item.matchingTerms = terms.filter(t => t[0] == '#' && tagsAlt.findIndex(tag => tag.startsWith(t)) >= 0)

        // match all terms (tag or non-tag) anywhere in text
        item.matchingTerms.push(...terms.filter(t => lctext.includes(t)))

        // match regex:* terms as regex
        item.matchingTerms.push(...regexTerms.filter(t => lctext.match(t)))

        // match id:* terms against id
        const id = 'id:' + item.id.toLowerCase()
        const saved_id = 'id:' + (item.savedId?.toLowerCase() ?? 'unsaved')
        const idMatchTerms = terms.filter(t => t == id || t == saved_id)
        item.matchingTerms.push(...idMatchTerms)
        if (idMatchTerms.length > 0) idMatchItemIndices.push(index)
        item.matchingTerms = _.uniq(item.matchingTerms) // can have duplicates (e.g. regex:*, id:*, ...)

        // match "secondary terms" ("context terms" against expanded tags, terms against item deps/dependents)
        // skip secondary terms (for ranking and highlighting) for listing item to avoid distraction
        item.matchingTermsSecondary = item.listing
          ? []
          : _.uniq(
              _.concat(
                termsContext.filter(
                  t =>
                    tagsExpanded.includes(t) ||
                    item.depsString.toLowerCase().includes(t) ||
                    item.dependentsString.toLowerCase().includes(t)
                ),
                terms.filter(
                  t => item.depsString.toLowerCase().includes(t) || item.dependentsString.toLowerCase().includes(t)
                )
              )
            )
        // do not duplicate primary matching terms in secondary
        item.matchingTermsSecondary = _.difference(item.matchingTermsSecondary, item.matchingTerms)

        // item is considered matching if primary terms match
        // (i.e. secondary terms are used only for ranking and highlighting matching tag prefixes)
        // (this is consistent with .index.matching in Item.svelte)
        item.matching = item.matchingTerms.length > 0
        if (item.matching) matchingItemCount++

        // listing item and id-matching item are considered "target" items
        item.target = item.listing || idMatchTerms.length > 0
        item.target_context = !item.target && context.includes(item.uniqueLabel)
        if (item.target) target = item
      } else {
        item.matchingTerms = []
        item.matchingTermsSecondary = []
        item.matching = false
        item.target = false
        item.target_context = false
      }

      // compute nesting level (-depth) of item name under target name
      item.target_nesting = item.target ? 0 : -Infinity
      if (!item.target && item.uniqueLabel.startsWith(terms[0] + '/')) {
        item.target_nesting = -1
        for (let i = terms[0].length + 1; i < item.uniqueLabel.length; ++i)
          if (item.uniqueLabel[i] == '/') item.target_nesting--
      }

      // compute minimum nesting level (max -depth) of item name under _prefixes_ of target name
      item.target_prefix_nesting = -Infinity
      if (!item.target && listingItemIndex >= 0) {
        const target_item = items[listingItemIndex]
        const { labelPrefixes } = target_item.expanded?.item ?? target_item
        for (const prefix of labelPrefixes) {
          if (!item.uniqueLabel.startsWith(prefix + '/')) continue
          let nesting = -1
          for (let i = prefix.length + 1; i < item.uniqueLabel.length; ++i) if (item.uniqueLabel[i] == '/') nesting--
          item.target_prefix_nesting = Math.max(nesting, item.target_prefix_nesting)
        }
      }

      // calculate missing tags (excluding certain special tags from consideration)
      // visible tags are considered "missing" if no other item contains them
      // hidden tags are considered "missing" if not a UNIQUE label (for unambiguous dependencies)
      // hidden "special" tags are not considered "missing" since they toggle special features
      // NOTE: doing this here is easier than keeping these updated in itemTextChanged
      // NOTE: tagCounts include prefix tags, deduplicated at item level
      item.missingTags = tagsVisible
        .filter(t => t != label && (tagCounts.get(t) || 0) <= 1)
        .concat(tagsHidden.filter(t => t != label && !isSpecialTag(t) && idsFromLabel.get(t)?.length != 1))

      // if (item.missingTags.length > 0) console.debug(item.missingTags, tags);

      // mark 'has error' on any logged errors or warnings
      // also mark if item has any failed _tests in its global store (set by #tester)
      item.hasError = !!text.match(/^(?:ERROR|WARNING):/m) || _.values(item.global_store?._tests).some(t => !t.ok)
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

    if (fixed) {
      const target = items.find(item => item.name == text)
      if (target) {
        items = [target, ..._.without(items, target)]
        hideIndexMinimal = hideIndexFixed = hideIndex = 1
      } else {
        items = _.sortBy(items, item => item.attr.shared.indices?.[shared_key] ?? Infinity)
        hideIndexMinimal =
          hideIndexFixed =
          hideIndex =
            _.sumBy(items, item => (item.shared.indices?.[shared_key] >= 0 ? 1 : 0))
      }
      updateItemLayout()
    } else {
      // insert dummy item to determine "tail" of items ranked _purely_ by time, i.e. below dummy w/ time==now
      // IMPORTANT: dummy should define all ranking-relevant attributes to avoid errors or NaNs (see note below)
      items.push({
        dotted: false,
        dotTerm: '',
        pinned: false,
        pinTerm: '',
        pinnedMatch: false,
        pinnedMatchTerm: '',
        log: false,
        uniqueLabel: '',
        target: false,
        editing: false,
        hasError: false,
        previewable: false,
        pushable: false,
        target_nesting: -Infinity,
        target_prefix_nesting: -Infinity,
        firstTagMatch: false,
        tagMatches: 0,
        labelMatch: false,
        prefixMatch: false,
        matchingTerms: [],
        matchingTermsSecondary: [],
        missingTags: [],
        time: now + 1000, // +1000 to dominate any time offsets used above
        id: null, // used below to find dummy after ranking
      })

      // returns position of minimum non-negative number, or -1 if none found
      // function min_pos(xJ) {
      //   let jmin = -1
      //   for (let j = 0; j < xJ.length; ++j) if (xJ[j] >= 0 && (jmin < 0 || xJ[j] < xJ[jmin])) jmin = j
      //   return jmin
      // }

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
          // target item (listing item or id-matching item)
          b.target - a.target ||
          // editing mode (except log items)
          (!b.log && b.editing) - (!a.log && a.editing) ||
          // errors
          b.hasError - a.hasError ||
          // previewables
          b.previewable - a.previewable ||
          // pushables
          b.pushable - a.pushable ||
          // nesting (depth of nested label) under target item
          b.target_nesting - a.target_nesting ||
          // minimum nesting (depth of nested label) under prefixes of target item
          b.target_prefix_nesting - a.target_prefix_nesting ||
          // position of (unique) label in listing item (item w/ unique label = first term)
          // (listing is reversed so larger index is better and missing=-1)
          listing.indexOf(b.uniqueLabel) - listing.indexOf(a.uniqueLabel) ||
          // first term tag match
          b.firstTagMatch - a.firstTagMatch ||
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
          // # of missing tags
          b.missingTags.length - a.missingTags.length ||
          // time (most recent first)
          b.time - a.time
      )

      // certain items need prominence to be considered in hide index and toggle point computations
      // note for editing items, log items which are edited "in place" and can be quite far down
      const needs_prominence = item =>
        item.target ||
        item.target_context ||
        item.editing ||
        item.hasError ||
        item.missingTags.length ||
        item.running ||
        item.pushable ||
        item.previewable

      // determine "tail" index (see above for definition)
      let tailIndex = items.findIndex(item => item.id === null)
      items.splice(tailIndex, 1)
      tailIndex = Math.max(tailIndex, _.findLastIndex(items, needs_prominence) + 1)
      let tailTime = items[tailIndex]?.time || 0
      if (_.findIndex(items, (item, i) => item.time < (items[i + 1]?.time || 0), tailIndex) >= 0)
        console.error('items are not ordered by time above tail index', tailIndex)
      hideIndexFromRanking = tailIndex

      // update layout (used below, e.g. aboveFold, editingItems, etc)
      updateItemLayout()
      lastEditorChangeTime = Infinity // force minimum wait for next change

      // determine "toggle" indices (ranges) where item visibility can be toggled
      toggles = []

      // when hideIndexFromRanking is large, we use position-based toggle points to reduce unnecessary computation
      // we include target + everything included above in hideIndexFromRanking to ensure prominence
      // we also consider special cutoffs for first unpinned item, first non-matching item, and first below-fold item
      const find_index = (pred, start = 0) => (i => (i >= 0 ? i : items.length))(_.findIndex(items, pred, start))
      let unpinnedIndex = find_index(item => !item.pinned && !needs_prominence(item))
      let nonmatchingIndex = find_index(item => !item.pinned && !item.matching && !needs_prominence(item))
      // let belowFoldIndex = _.findLastIndex(items, item => item.aboveFold || needs_prominence(item)) + 1
      let belowFoldIndex = find_index(item => !item.aboveFold && !needs_prominence(item))
      if (unpinnedIndex < Math.min(nonmatchingIndex, belowFoldIndex, hideIndexFromRanking)) {
        toggles.push({
          start: unpinnedIndex,
          end: Math.min(nonmatchingIndex, belowFoldIndex, hideIndexFromRanking),
          positionBased: true,
          type: 'unpinned',
        })
      }
      if (nonmatchingIndex < Math.min(belowFoldIndex, hideIndexFromRanking)) {
        toggles.push({
          start: nonmatchingIndex,
          end: Math.min(belowFoldIndex, hideIndexFromRanking),
          positionBased: true,
          type: 'non-matching',
        })
      }
      if (belowFoldIndex < hideIndexFromRanking) {
        let lastToggleIndex = belowFoldIndex
        const blocks = [10, 30, 50] // + every 50 until past hideIndexFromRanking
        do {
          blocks.push(_.last(blocks) + 50)
        } while (belowFoldIndex + _.last(blocks) < hideIndexFromRanking)
        for (const size of blocks) {
          const start = lastToggleIndex
          const end = Math.min(belowFoldIndex + size, hideIndexFromRanking)
          // split toggle if it crosses first non-matching item
          if (start < nonmatchingIndex && end > nonmatchingIndex) {
            toggles.push({ start, end: nonmatchingIndex, positionBased: true, type: 'below fold, matching' })
            toggles.push({ start: nonmatchingIndex, end, positionBased: true, type: 'below fold, non-matching' })
          } else toggles.push({ start, end, positionBased: true, type: 'below fold' })
          // split toggle if it crosses nonmatchingIndex
          lastToggleIndex = belowFoldIndex + size
          if (lastToggleIndex >= hideIndexFromRanking) break
        }
      }

      // ensure contiguity of position-based toggles up to hideIndexFromRanking
      if (toggles.length > 0) toggles[toggles.length - 1].end = hideIndexFromRanking

      // merge position-based toggles smaller than 10 indices, starting at non-matching index
      for (let i = 1; i < toggles.length; i++) {
        if (toggles[i].start == nonmatchingIndex) continue // do not merge toggle at first non-matching item
        if (toggles[i - 1].end - toggles[i - 1].start < 10 || toggles[i].end - toggles[i].start < 10) {
          toggles[i - 1].end = toggles[i].end
          toggles.splice(i--, 1) // merged into last
        }
      }

      // console.debug(toggles.slice(), unpinnedIndex, nonmatchingIndex, belowFoldIndex, hideIndexFromRanking)

      // calculate "minimal" hide index used in certain situations, e.g. when window is defocused
      // minimal index is either the first time-ranked item, or the first position-based hidden item
      // w/o target item, first position toggle (first unpinned) is auto-opened to show most recently touched items
      hideIndexMinimal = toggles.length == 0 ? hideIndexFromRanking : target ? toggles[0].start : toggles[0].end

      // first time-based toggle point is the "session toggle" for items "touched" in this session (since first ranking)
      // note soft-touched items are special in that they can be hidden by going back, and will be reset upon loading
      // when items are ordered by a query (vs just time), we only consider up to first unpinned item untouched in session
      // otherwise touched items could be arbitrarily low in ranking and we would have to show many untouched items
      hideIndexForSession = find_index(item => !item.pinned && item.time < sessionTime, hideIndexFromRanking)

      // auto-show session items (incl. all ranked items) if no position-based toggles, otherwise revert to minimal
      const hideIndexIdeal = toggles.length == 0 ? hideIndexForSession : hideIndexMinimal
      // disallow decrease in hideIndex unless there is a query, to improve focus
      if ((text && editorTextModified) || hideIndexIdeal > hideIndex) hideIndex = hideIndexIdeal

      // if ranking while unfocused, retreat to minimal index
      // if (!focused) hideIndex = hideIndexMinimal

      if (hideIndexForSession > hideIndexFromRanking && hideIndexForSession < items.length) {
        toggles.push({
          start: hideIndexFromRanking,
          end: hideIndexForSession,
        })
        tailIndex = hideIndexForSession
        tailTime = items[hideIndexForSession].time
      }

      // add toggle points for "extended tail times"
      // we do this by time to have more intuitive toggles, but split further every 50 items as needed
      const blocks = [1, 3, 7, 14, 30] // + every 30d until past oldest item
      do {
        blocks.push(_.last(blocks) + 30)
      } while (Date.now() - _.last(blocks) * 24 * 3600 * 1000 >= oldestTime)
      for (let j = 0; j < blocks.length; ++j) {
        const extendedTailTime = Date.now() - blocks[j] * 24 * 3600 * 1000
        if (extendedTailTime >= tailTime) continue
        let extendedTailIndex = _.findIndex(items, item => item.time < extendedTailTime, tailIndex + 1)
        // restrict each toggle to 50 items max
        if (extendedTailIndex - tailIndex > 50) {
          extendedTailIndex = tailIndex + 50
          j-- // stay in current block
        }
        if (extendedTailIndex < 0) extendedTailIndex = items.length
        toggles.push({
          start: tailIndex,
          end: extendedTailIndex,
        })
        tailIndex = extendedTailIndex
        tailTime = items[extendedTailIndex]?.time || oldestTime
        if (tailIndex == items.length) break
      }

      // sanity check toggles are non-empty, contiguous, and complete
      for (let i = 0; i < toggles.length - 1; i++) {
        if (toggles[i].end <= toggles[i].start) console.error('toggles are not non-empty', toggles)
        if (toggles[i].end !== toggles[i + 1].start) console.error('toggles are not contiguous', toggles)
      }
      if (toggles.length && _.last(toggles).end != items.length) console.error('toggles are incomplete', toggles)

      // align hideIndex to next toggle.start (could be misaligned e.g. if there are no position-based toggles)
      // hideIndex = toggles.find(toggle => toggle.start >= hideIndex)?.start ?? items.length

      // insert toggle at hideIndex if needed
      if (hideIndex < items.length) {
        const hideToggleIndex = toggles.findIndex(toggle => toggle.start >= hideIndex)
        if (hideToggleIndex < 0) {
          if (toggles.length > 0) console.error('invalid toggles', toggles) // should not happen given checks above
          toggles = [{ start: hideIndex, end: items.length }]
        } else if (toggles[hideToggleIndex].start > hideIndex) {
          toggles.splice(hideToggleIndex, 0, { start: hideIndex, end: toggles[hideToggleIndex].start })
          if (hideToggleIndex > 0) toggles[hideToggleIndex - 1].end = hideIndex
        }
      } else if (hideIndex > items.length) {
        console.error('invalid hideIndex', hideIndex, items.length)
      }

      // console.debug(toggles, belowFoldIndex, hideIndexFromRanking, hideIndexForSession, hideIndexMinimal, hideIndex)
    }

    // note this check is already done in updateItemLayout but is also necessary here in case hideIndex was increased
    // to avoid displaying .loading overlay multiple times, we only allow a one-way change unless query has changed
    if (renderingVisibleItems || (text && editorTextModified)) checkIfRenderingVisibleItems()

    if (!ignoreStateOnEditorChange) {
      // update history, replace unless current state is final (from tag click)
      const orderHash = hash(items.map(item => item.id).join())
      if (editorText != history.state.editorText || orderHash != history.state.orderHash) {
        // need to update history
        const state = {
          index: undefined, // set below depending on push vs replace
          editorText,
          unsavedTimes: items.filter(item => item.time != item.savedTime).map(item => _.pick(item, ['id', 'time'])),
          orderHash,
          hideIndex,
          scrollPosition: document.body.scrollTop,
          final: finalizeStateOnEditorChange,
          intro,
        }
        // console.debug(history.state.final ? "push" : "replace", state);
        if (forceNewStateOnEditorChange || (history.state.final && !replaceStateOnEditorChange)) {
          state.index = ++sessionStateHistoryIndex
          sessionStateHistory.length = sessionStateHistoryIndex + 1 // may truncate
          pushState(state)
          // TODO: remove this once you understand why states in history can sometimes be undefined; seems to be related to going back across page reloads (vs opening a fresh tab) but it is not clear how exactly
          sessionStateHistory.forEach((state, j) => {
            if (!state)
              console.error(
                `sessionStateHistory has gap at index ${j} (last ${
                  sessionStateHistory.length - 1
                }, current ${sessionStateHistoryIndex})`
              )
          })
        } else {
          state.index = sessionStateHistoryIndex
          replaceState(state)
        }
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
        if (!itemDefinesFunction(item, '_on_search')) return
        Promise.resolve(
          _item(item.id).eval(`_on_search(\`${editorText.replace(/[`\\$]/g, '\\$&')}\`)`, {
            trigger: 'listen',
            async: item.deepasync, // run async if item is async or has async deps
            async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
          })
        ).catch(e => {}) // already logged
      })
    })

    const elapsed = Date.now() - start
    if (elapsed > 250) {
      // dispatch warning to avoid writing to items if invoked synchronously, e.g. via _create
      setTimeout(() => console.warn(`onEditorChange took ${elapsed}ms`))
    }
  }

  function checkIfRenderingVisibleItems() {
    // this needs to be done wherever either item layout OR hideIndex is updated
    // we can check for height==0 or !item.rendered if we want to also wait for images/scripts/math/etc
    // we allow editing items since the rendered item (item.elem) is not visible on page
    // we would also allow below-fold items, but unfortunately that is not reliable when heights are unknown
    renderingVisibleItems =
      hideIndex > 0 && _.findLastIndex(items, item => !item.rendered && !item.editing, hideIndex - 1) >= 0
  }

  function toggleItems(index: number) {
    hideIndex = index
    checkIfRenderingVisibleItems()
    replaceState(Object.assign(history.state, { hideIndex }))
  }

  function scrollToTarget() {
    const target = document.querySelector(`.super-container.target`) as HTMLElement
    if (!target) return // target missing, can happen even under unique match (e.g. for #log items)
    // if target is too far up or down, bring it to ~upper-middle, snapping up to header
    if (
      target.offsetTop < document.body.scrollTop ||
      target.offsetTop > document.body.scrollTop + visualViewport.height - 200
    )
      scrollTo(Math.max(headerdiv.offsetTop, target.offsetTop - visualViewport.height / 4))
  }

  function onTagClick(id: string, tag: string, reltag: string, e: MouseEvent) {
    focus() // ensure window focus on tag click (mousedown)
    const index = indexFromId.get(id)
    if (index === undefined) return // deleted
    // "soft touch" item if not already newest and not pinned and not log
    // skip time change if alt is held
    if (!e.altKey) {
      // if (items[index].time > newestTime) console.warn('invalid item time')
      if (items[index].time > newestTime) newestTime = items[index].time
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
        prefix_click = tag.includes('/', pos)
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

    if (editorText.trim().toLowerCase() == tag.toLowerCase() && !fixed) {
      if (prefix_click) {
        // assuming trying to go to a parent/ancestor
        if (!confirm(`Tag ${tag} already selected. Clear selection?`)) return
      } // else if (!confirm(`Tag ${tag} already selected. Clear selection?`)) return
      editorText = '' // assume intentional toggle (clear)
    } else {
      editorText = tag + ' ' // space in case more text is added
    }
    forceNewStateOnEditorChange = true // force new state
    finalizeStateOnEditorChange = true // finalize state
    tick().then(() => editor.setSelection(editorText.length, editorText.length))
    lastEditorChangeTime = 0 // disable debounce even if editor focused
    // maintain item times if altKey is held, e.g. with arrow-based navigation considered somehwat less "intentional"
    onEditorChange(editorText, e.altKey /* keep_times */)

    if (narrating) return
    // scroll to target item if needed
    if (items.some(item => item.target)) update_dom().then(scrollToTarget)
  }

  function onLinkClick(id: string, href: string, e: MouseEvent) {
    const index = indexFromId.get(id)
    if (index === undefined) return // deleted
    // "soft touch" item if not already newest and not pinned and not log
    // if (items[index].time > newestTime) console.warn('invalid item time')
    if (items[index].time > newestTime) newestTime = items[index].time
    else if (items[index].time < newestTime && !items[index].pinned && !items[index].log) {
      items[index].time = Date.now()
      lastEditorChangeTime = 0 // disable debounce even if editor focused
      onEditorChange(editorText) // item time has changed
    }
  }

  function onLogSummaryClick(id: string) {
    let index = indexFromId.get(id)
    if (index === undefined) return
    items[index].showLogs = !items[index].showLogs
    items[index].showLogsTime = Date.now() // invalidates auto-hide
  }

  let scrollToTopOnPopState = false
  function onPopState(e) {
    readonly = (anonymous && !admin) || (fixed && sharer != user?.uid)
    if (!e?.state) return // for fragment (#id) hrefs
    if (!initialized) {
      // NOTE: this can happen when tab is restored, seems harmless so far
      // console.warn("onPopState before init");
      return
    }
    //console.debug('onPopState', e.state, items.length + ' items')

    // restore intro mode for narration
    intro = e.state.intro

    // update session history index to the popped state
    // note we could be going back or forward w/ jumps allowed
    if (e.state.index === null) console.error('popping state w/o index! (taking it as 0)')
    sessionStateHistoryIndex = e.state.index ?? 0

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
    update_dom().then(() => {
      if (scrollToTopOnPopState) {
        scrollTo(headerdiv.offsetTop)
        scrollToTopOnPopState = false
      } else {
        // scroll to last recorded scroll position at this state
        scrollTo(e.state.scrollPosition || 0)
      }
    })
  }

  function onBeforeUnload(e) {
    if (items.every(item => item.text == item.savedText)) return
    const msg = 'Discard unsaved changes?'
    // see https://stackoverflow.com/a/7317311
    e.returnValue = msg // gecko + ie
    return msg // gecko + webkit, safari, chrome, etc
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
    getAuth(firebase)
      .signOut()
      .then(() => {
        console.debug('signed out')
        location.reload()
      })
      .catch(console.error)
  }

  let idsFromLabel = new Map<string, string[]>()
  function itemDeps(index, deps = [], missing_deps = undefined) {
    let item = items[index]
    if (deps.includes(item.id)) return deps
    // NOTE: dependency order matters for hashing and potentially for code import
    deps = [item.id].concat(deps) // prepend temporarily to avoid cycles, moved to back below
    const root = deps.length == 1
    item.tagsHiddenAlt.forEach(tag => {
      // NOTE: we allow special tags as dependents if corresponding uniquely named items exist
      // if (isSpecialTag(tag)) return;
      if (!idsFromLabel.has(tag)) {
        // record tag as missing if not special or an "alt" of a special tag
        if (!isSpecialTag(tag) && item.tagsHidden.includes(tag)) missing_deps?.push(tag)
        return
      }
      const ids = idsFromLabel.get(tag)
      if (ids.length == 0 || ids.length > 1) {
        // record tag as missing if not special or an "alt" of a special tag
        if (!isSpecialTag(tag) && item.tagsHidden.includes(tag)) missing_deps?.push(tag)
        return
      }
      ids.forEach(id => {
        // NOTE: idsFromLabel should never return deleted items!
        const dep_index = indexFromId.get(id)
        if (dep_index === undefined) throw new Error(`idsFromLabel.get(${tag}) returned deleted id ${id}`)
        deps = itemDeps(dep_index, deps, missing_deps)
      })
    })
    return root ? deps.slice(1) : deps.slice(1).concat(item.id)
  }

  function itemDepsString(item) {
    return item.deps
      .map(id => {
        const dep = __item(id)
        return dep.name + (dep.deepasync ? '(async)' : '')
      })
      .join(' ')
  }

  function itemDependentsString(item) {
    return item.dependents
      .map(id => {
        const dep = __item(id)
        const visible = item.labelUnique && dep.tagsVisible.includes(item.label)
        return dep.name + (visible ? '(visible)' : '')
      })
      .join(' ')
  }

  function resolveTag(label, tag) {
    let resolved = tag
    if (tag == label) resolved = tag
    else if (tag.startsWith('#///') && label.match(/\/[^\/]*?\/[^\/]*$/))
      resolved = label.replace(/\/[^\/]*?\/[^\/]*$/, '') + tag.substring(3)
    else if (tag.startsWith('#///') && label.match(/^#[^\/]*?\/[^\/]*$/)) resolved = '#' + tag.substring(4)
    else if (tag.startsWith('#//') && label.match(/\/[^\/]*$/))
      resolved = label.replace(/\/[^\/]*$/, '') + tag.substring(2)
    else if (tag.startsWith('#//') && label.match(/^#[^\/]*$/)) resolved = '#' + tag.substring(3)
    else if (tag.startsWith('#/')) resolved = label + tag.substring(1)

    if (resolved.startsWith('#/')) return // return undefined on failure to resolve tag relative to label
    return resolved
  }

  function resolveTags(label, tags) {
    return tags.map(tag => resolveTag(label, tag)).filter(t => t) // drop unresolved tags
  }

  // callback triggered by (successful) macro expansion during rendering
  function onMacrosExpanded(index: number, expanded: any) {
    const item = items[index]
    item.expanded = expanded
    itemExpansionChanged(item)
  }

  let expansionRerankPending = false
  function itemExpansionChanged(item) {
    if (item.expanded.item) throw new Error('unexpected expanded item state') // sanity check
    if (item.expanded.count == 0) return // no macro expansions, so no need for expanded.item

    // precompute macro-expanded item state used for search in onEditorChange and store in item.expanded.item
    // we reuse itemTextChanged (w/ update_deps:false) to switch temporarily to expanded text and back
    // this is simpler, ensures consistency, and is also easy to extend to other item state in future
    itemTextChanged(item.index, item.expanded.text, false /* skip deps */)
    item.expanded.item = _.pick(item, [
      // these names should match destructured item state in onEditorChange
      'tagsVisibleExpanded',
      'tagsVisible',
      'label',
      'labelPrefixes',
      'header',
      'tagsHidden',
      'labelUnique',
      'tagsAlt',
      'lctext',
      'tagsExpanded',
      'text',
    ])
    // note this call may use item.expanded.item.* to update certain global state, e.g. tagCounts
    itemTextChanged(item.index, item.text, false /* skip deps */)

    // if there is a query, trigger rerank/rehighlight with 1s debounce
    if (editorText.trim() && !expansionRerankPending) {
      expansionRerankPending = true
      setTimeout(() => {
        expansionRerankPending = false
        onEditorChange(editorText)
      }, 1000)
    }
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
    const item = items[index]
    // console.debug("itemTextChanged", item.name);
    item.hash = hash(text)
    item.lctext = text.toLowerCase()
    item.runnable = item.lctext.match(blockRegExp('\\S+_input(?:_hidden|_removed)? *')) // note input type required
    // changes in mindpage can reset (but not set) previewable flag
    // only changes in local repo (detected in fetchPreview) can set previewable
    if (text == item.previewText) item.previewable = false

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
    item.pinned = !fixed && pintags.length > 0
    item.pinTerm = pintags[0] || ''
    item.dotted = !fixed && pintags.findIndex(t => t.match(/^#_pin\/dot(?:\/|$)/)) >= 0
    item.dotTerm = pintags.filter(t => t.match(/^#_pin\/dot(?:\/|$)/))[0] || ''

    // if item stats with visible #tag, it is taken as a "label" for the item
    // (we allow some html tags/macros to precede the label tag for styling purposes)
    const prevLabel = item.label
    item.header = item.lctext.match(/^(?:\s*<.*>\s*)*([^\n]*)/).pop()
    item.label = item.header.startsWith(item.tagsVisible[0]) ? item.tagsVisible[0] : ''
    item.labelText = item.label ? item.text.replace(/^<.*>\s+#/, '#').slice(0, item.label.length) : ''
    item.labelUnique ??= false
    item.labelPrefixes ??= []
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
        const ids = _.pull(idsFromLabel.get(prevLabel), item.id)
        // console.debug('removed id for label', prevLabel, ids)
        if (ids.length == 1) {
          let other = __item(ids[0])
          other.labelUnique = true
          other.name = other.labelUnique ? other.labelText : 'id:' + other.id
        } else if (ids.length == 0) {
          // delete to ensure all keys are used
          idsFromLabel.delete(prevLabel)
        }
      }
      if (item.label) {
        let ids = idsFromLabel.get(item.label)
        if (!ids) idsFromLabel.set(item.label, (ids = [item.id]))
        else ids.push(item.id)
        // console.debug('added id for label', item.label, ids)
        item.labelUnique = ids.length == 1
        if (ids.length == 2) {
          let other = __item(ids[0])
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
    item.tagsExpanded = _.uniq(item.tags.concat(item.tags.map(tagPrefixes).flat()))
    item.tagsVisibleExpanded = _.uniq(item.tagsVisible.concat(item.tagsVisible.map(tagPrefixes).flat()))

    // update tagCounts to include prefixes AND any additional tags from macro expansions
    const prevTagsExpandedWithMacros = item.tagsExpandedWithMacros || []
    item.tagsExpandedWithMacros = item.tagsExpanded
    if (item.expanded?.item?.tagsExpanded)
      // include macro expansions
      item.tagsExpandedWithMacros = item.tagsExpandedWithMacros.concat(item.expanded.item.tagsExpanded)
    if (!_.isEqual(item.tagsExpandedWithMacros, prevTagsExpandedWithMacros)) {
      prevTagsExpandedWithMacros.forEach(tag => tagCounts.set(tag, tagCounts.get(tag) - 1))
      item.tagsExpandedWithMacros.forEach(tag => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1))
    }

    // extract title, if any found, as the first non-tag non-html non-empty line
    // as with header (see above), we allow some html tag lines and/or hash tag lines before title line
    item.title = item.text.match(/^(?:\s*(?:<|#[^#\s])[^\n]*\n)*?(?:\s{0,3}#{1,6}\s+)([^\n]*)/)?.pop()

    if (update_deps) {
      const prevDeps = item.deps || []
      const prevDependents = item.dependents || []
      item.deps = itemDeps(index)
      // console.debug('updated dependencies:', item.label, prevLabel, item.deps, prevDeps)

      const prevDeepHash = item.deephash
      item.deephash = hash(
        item.deps
          .map(id => __item(id).hash)
          .concat(item.hash)
          .join(',')
      )
      if (item.deephash != prevDeepHash && !item.log && !keep_time) item.time = Date.now()
      item.deepasync = item.async || item.deps.some(id => __item(id).async)

      // warn about new _init or _welcome items
      // doing this under update_deps ensures item is new or modified (vs initialized)
      if (item.init && !prev_init) {
        console.warn(`new init item ${item.name} may require reload`)
        item.shouldReload = true
      } else if (item.welcome && !prev_welcome) {
        console.warn(`new welcome item ${item.name} may require reload`)
        item.shouldReload = true
      }
      const new_init_welcome_item_id = (item.init && !prev_init) || (item.welcome && !prev_welcome) ? item.id : null

      // if deephash has changed, invoke _on_item_change on all _listen (or self) items
      // also warn about modified (based on deephash) _init or _welcome items
      function invoke_listeners_for_changed_item(id, label, prev_label, dependency = false) {
        const item = __item(id)
        if ((item.init || item.welcome) && id != new_init_welcome_item_id && !dependency) {
          console.warn(
            `${dependency ? 'dependency-' : ''}modified ${item.init ? 'init' : 'welcome'} ` +
              `item ${item.name} may require reload`
          )
          item.shouldReload = true
        }
        setTimeout(() => {
          const deleted = !indexFromId.has(id)
          items.forEach(item => {
            if (!item.listen && item.id != id) return // must be listener or self
            if (!itemDefinesFunction(item, '_on_item_change')) return
            Promise.resolve(
              _item(item.id).eval(
                `_on_item_change('${id}','${label}','${prev_label}',${deleted},${remote},${dependency})`,
                {
                  trigger: item.listen ? 'listen' : 'change',
                  async: item.deepasync, // run async if item is async or has async deps
                  async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
                }
              )
            ).catch(e => {}) // already logged
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
            depitem.deephash = hash(
              depitem.deps
                .map(id => __item(id).hash)
                .concat(depitem.hash)
                .join(',')
            )
            if (depitem.deephash != depitem_prevDeepHash)
              invoke_listeners_for_changed_item(depitem.id, depitem.label, depitem.label, true /*dependency*/)
            depitem.deepasync = depitem.async || depitem.deps.some(id => __item(id).async)
            // if run_deps is enabled and item has _autorun, also dispatch run (w/ sanity check for non-deletion)
            // NOTE: run_deps is slow/expensive and e.g. should be false when synchronizing remote changes
            if (run_deps && depitem.autorun)
              setTimeout(() => {
                if (depitem.index == indexFromId.get(depitem.id)) onItemRun(depitem.index, false /* touch_first */)
              })
          }
          if (depitem.deps.includes(item.id)) item.dependents.push(depitem.id)
        })
        // console.debug('updated dependents:', item.label, prevLabel, item.dependents, prevDependents)
      }

      // update deps/dependents strings
      item.depsString = itemDepsString(item)
      item.dependentsString = itemDependentsString(item)

      // update dependents for dependencies and vice versa (including strings)
      _.uniq(item.deps.concat(prevDeps)).forEach((id: string) => {
        const dep = __item(id)
        if (item.deps.includes(dep.id) && !dep.dependents.includes(item.id)) dep.dependents.push(item.id)
        else if (!item.deps.includes(dep.id) && dep.dependents.includes(item.id)) {
          // NOTE: when removing item as a dependent from a previous dependency, we have to review all dependents of the dependecy since it may also have _indirect_ dependents through this item
          _.remove(dep.dependents, (id: string) => id == item.id || !__item(id).deps.includes(dep.id))
          // console.debug('updated dependency dependents:', dep.name, dep.dependents)
        }
        dep.dependentsString = itemDependentsString(dep)
        // console.debug("updated dependentsString:", dep.dependentsString);
      })
      _.uniq(item.dependents.concat(prevDependents)).forEach((id: string) => {
        const dep = __item(id)
        dep.depsString = itemDepsString(dep)
      })
    }
  }

  // NOTE: secret phrase is initialized OR retrieved only ONCE PER SESSION so that it can not be tampered with after having been used to decrypt existing items; otherwise account can contain items encrypted using different secret phrases, which would make the account unusable
  let secret // retrieved once and stored separately to prevent tampering during session

  import { tick } from 'svelte'
  async function getSecretPhrase(new_phrase: boolean = false) {
    if (anonymous) throw Error('anonymous user can not have a secret phrase')
    if (readonly) throw Error('readonly mode should not require a secret phrase')
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

  // function stringToUint16Array(str) {
  //   const array = new Uint16Array(str.length)
  //   const len = str.length
  //   for (let i = 0; i < len; i++) array[i] = str.charCodeAt(i)
  //   return array
  // }

  // encrypt text w/ utf8 encoding for given string and base64-encoding for encrypted cipher
  // based on https://gist.github.com/chrisveness/43bcda93af9f646d083fad678071b90a
  // ideal for firestore database since cipher is easy to view, copy, etc
  // overhead for text is ~20% cpu time (utf8) and ~30% storage (base64)
  // overhead for binary can be ~60% cpu time (utf8 for ~50% larger buffers) and ~2x storage (utf8+base64)
  async function encrypt(text: string): Promise<string> {
    if (!secret) secret = getSecretPhrase(true /* new_phrase */)
    secret = await Promise.resolve(secret) // resolve secret if promise pending
    const secret_utf8 = new TextEncoder().encode(secret) // utf8-encode secret
    const secret_sha256 = await crypto.subtle.digest('SHA-256', secret_utf8) // sha256-hash the secret
    const iv = crypto.getRandomValues(new Uint8Array(12)) // get 96-bit random iv
    const alg = { name: 'AES-GCM', iv: iv } // configure AES-GCM
    const key = await crypto.subtle.importKey('raw', secret_sha256, alg, false, ['encrypt']) // generate key
    const cipher_buffer = await crypto.subtle.encrypt(alg, key, new TextEncoder().encode(text)) // encrypt using key
    const iv_hex = Array.from(iv)
      .map(b => ('00' + b.toString(16)).slice(-2))
      .join('') // convert iv to hex string (of length 24)
    return iv_hex + btoa(byteArrayToString(new Uint8Array(cipher_buffer)))
  }

  // encrypt arbitrary bytes (uint8)
  // ideal for firebase storage of large binary data such as images
  async function encrypt_bytes(bytes: Uint8Array): Promise<Uint8Array> {
    if (!secret) secret = getSecretPhrase(true /* new_phrase */)
    secret = await Promise.resolve(secret) // resolve secret if promise pending
    const secret_utf8 = new TextEncoder().encode(secret) // utf8-encode secret
    const secret_sha256 = await crypto.subtle.digest('SHA-256', secret_utf8) // sha256-hash the secret
    const iv = crypto.getRandomValues(new Uint8Array(12)) // get 96-bit random iv
    const alg = { name: 'AES-GCM', iv: iv } // configure AES-GCM
    const key = await crypto.subtle.importKey('raw', secret_sha256, alg, false, ['encrypt']) // generate key
    const cipher_buffer = await crypto.subtle.encrypt(alg, key, bytes) // encrypt text using key
    const iv_hex = Array.from(iv)
      .map(b => ('00' + b.toString(16)).slice(-2))
      .join('') // convert iv to hex string (of length 24)
    return concatByteArrays(byteStringToArray('~' + iv_hex), new Uint8Array(cipher_buffer))
  }

  async function decrypt(cipher: string): Promise<string> {
    // if (cipher[0] == '~') return byteArrayToString(await decrypt_bytes(byteStringToArray(cipher)))
    if (cipher[0] == '~') throw new Error('data encrypted using encrypt_bytes must be decrypted using decrypt_bytes')
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
    const cipher_array = byteStringToArray(atob(cipher.slice(24))) // base64-decode cipher string (encrypted in text mode)
    const text_buffer = await crypto.subtle.decrypt(alg, key, cipher_array) // decrypt cipher using key
    return new TextDecoder().decode(text_buffer) // utf8-decode text
  }

  async function decrypt_bytes(cipher: Uint8Array): Promise<Uint8Array> {
    if (!secret) secret = getSecretPhrase()
    secret = await Promise.resolve(secret) // resolve secret if promise pending
    const secret_utf8 = new TextEncoder().encode(secret) // utf8-encode secret
    const secret_sha256 = await crypto.subtle.digest('SHA-256', secret_utf8) // sha256-hash the secret
    // detect uint8 ("bytes") mode based on ~ prefix
    const encrypted_bytes = cipher[0] == '~'.charCodeAt(0)
    const offset = encrypted_bytes ? 1 : 0 // uint8 encoding has offset 1 for '~' prefix
    const iv = byteArrayToString(cipher.subarray(offset, 24 + offset))
      .match(/.{2}/g)
      .map(byte => parseInt(byte, 16)) // get iv from cipher
    const alg = { name: 'AES-GCM', iv: new Uint8Array(iv) } // configure AES-GCM
    const key = await crypto.subtle.importKey('raw', secret_sha256, alg, false, ['decrypt']) // generate key
    const cipher_array = encrypted_bytes
      ? cipher.subarray(24 + offset)
      : byteStringToArray(atob(byteArrayToString(cipher.subarray(24 + offset))))
    const text_buffer = await crypto.subtle.decrypt(alg, key, cipher_array) // decrypt cipher using key
    if (encrypted_bytes) return new Uint8Array(text_buffer) // return raw uint8 array
    // backwards compatibility mode: convert utf8-decoded text to uint8 array (code points <= 255 only)
    return byteStringToArray(new TextDecoder().decode(text_buffer))
  }

  async function encryptItem(item) {
    if (anonymous) return item // do not encrypt for anonymous user
    if (item.cipher) return item // already encrypted
    if (item.attr?.shared) {
      // do not encrypt shared items
      item.cipher = null // clear cipher if was previously encrypted
      return item
    }
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

  // note return value of this function is also returned to any programmatic context where commands are triggered, either directly via return value of _create, or indirectly via window._mindbox_return when triggered via MindBox using dispatched DOM events (e.g. as in MindBox.create); only allowed return values are undefined, null, or _Item, w/ strings in particular reserved for alerting errors returned as a string due to return_alerts option
  function handleCommandReturn(cmd, item, obj, run, edit, return_alerts, handleError) {
    if (typeof obj == 'string') {
      lastEditorChangeTime = 0 // disable debounce even if editor focused
      onEditorChange(obj)
      setTimeout(() => textArea(-1).focus()) // refocus (may require dispatch)
    } else if (obj === undefined) {
      lastEditorChangeTime = 0 // disable debounce even if editor focused
      onEditorChange('')
      setTimeout(() => textArea(-1).blur()) // defocus, requires dispatch on chrome
    } else if (obj === null || obj instanceof _Item) {
      return obj // return null or item as is, w/o any changes to editor for full flexibility
    } else if (typeof obj != 'object' || !obj.text || typeof obj.text != 'string') {
      const msg = `invalid return for command ${cmd} handled in item ${item.name}`
      if (return_alerts) return msg
      _modal(msg)
    } else {
      const text = obj.text
      // since we are async, we need to call onEditorDone again with run/editing set properly
      // obj.{edit,run,history,command,mindbox_text,emulate_button} can override defaults
      // default run/edit are passed in args, default history/command are false
      // default mindbox_text is blank, most sensible for item creation via command (vs programmatic)
      // use mindbox_text == null to maintain text as is, or undefined to maintain existing mindbox text
      obj.run ??= run
      obj.edit ??= edit
      obj.history ??= false
      obj.command ??= false
      obj.mindbox_text ??= ''
      obj.return_alerts ??= return_alerts
      let textarea = textArea(-1)
      // reset focus for generated text
      textarea.selectionStart = textarea.selectionEnd = 0
      let item = _create(text, obj)
      // run programmatic initializer (and return promise) if any
      if (obj.init) {
        try {
          return Promise.resolve(obj.init(item)).catch(handleError)
        } catch (e) {
          handleError(e)
          throw e
        }
      }
      return item
    }
  }

  let sessionCounter = 0 // to ensure unique increasing temporary ids for this session
  let sessionHistory = []
  let sessionHistoryIndex = 0
  let tempIdFromSavedId = new Map<string, string>()
  let installing = false
  let installed_dependencies = new Set<string>()
  let editorText = ''
  let editor

  function onEditorDone(
    text: string,
    e: any = null,
    cancelled: boolean = false,
    run: boolean = false,
    editing = null,
    attr = null,
    ignore_command = false,
    return_alerts = false
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
    // console.debug('onEditorDone', { text, e, cancelled, run, editing, attr, ignore_command })

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
    if (e?.shiftKey) run = false
    // force editing if text is empty
    // if (!text.trim()) editing = true

    // overload alert function to return alert message if return_alerts==true (useful for background commands)
    // also uses async _modal due to known issues with alert in ios (see assignment to window.alert)
    // should always be invoked as return alert(...)
    const alert = msg => {
      const was_focused = document.activeElement == textArea(-1)
      if (return_alerts) return msg // return alert message string
      else _modal_alert(msg, () => was_focused && textArea(-1).focus())
    }

    if (!ignore_command) {
      switch (text.trim()) {
        case '/_signout': {
          if (!signedin) return alert('already signed out')
          signOut()
          return
        }
        case '/_signin': {
          if (signedin) return alert('already signed in')
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
          if (editingItems.length == 0) return alert('/_times: no item selected')
          const item = items[editingItems[0]]
          // note updateTime and createTime are also available in firebase docs (not shapshots)
          text = new Date(item.time).toString()
          break
        }
        case '/_edit': {
          if (editingItems.length == 0) return alert('/_edit: no item selected')
          const item = items[editingItems[0]]
          _item(item.id).editable = true // set via _Item setter
          tick().then(() => textArea(item.index)?.focus())
          lastEditorChangeTime = 0 // disable debounce even if editor focused
          onEditorChange('')
          return
        }
        case '/_unedit': {
          if (editingItems.length == 0) return alert('/_unedit: no item selected')
          const item = items[editingItems[0]]
          _item(item.id).editable = false // set via _Item setter
          lastEditorChangeTime = 0 // disable debounce even if editor focused
          onEditorChange('')
          return
        }
        case '/_updates': {
          if (editingItems.length == 0) return alert('/_updates: no item selected')
          const item = items[editingItems[0]]
          if (!item.attr?.source)
            return alert(`/_updates: selected item ${item.name} was not installed via /_install command`)
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
                _modal(
                  `No updates available for [${attr.path}](${attr.source}).  \n` +
                    `[Last update](${installed_update}) (_installed_) was ${time_ago}.  \n` +
                    `See [history](${history}) for past updates.`
                )
              } else {
                // there are updates!
                const index = data.findIndex(commit => commit.sha == attr.sha)
                let update_count = index < 0 ? data.length + '+' : index
                update_count += update_count === 1 ? ' update' : ' updates'
                if (index >= 0) data.length = index
                _modal(
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
                    `See [history](${history}) for all updates.`
                )
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
          if (editingItems.length == 0) return alert('/_dependencies: no item selected')
          if (editingItems.length > 1) return alert('/_dependencies: too many items selected')
          text = items[editingItems[0]].depsString
          clearLabel = true
          break
        }
        case '/_dependents': {
          if (editingItems.length == 0) return alert('/_dependents: no item selected')
          if (editingItems.length > 1) return alert('/_dependents: too many items selected')
          text = items[editingItems[0]].dependentsString
          clearLabel = true
          break
        }
        case '/_backup': {
          if (readonly) return
          let added = 0
          items.forEach(item => {
            addDoc(collection(getFirestore(firebase), 'history'), {
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
          getDoc(doc(collection(getFirestore(firebase), 'items'), 'QbtH06q6y6GY4ONPzq8N'))
            .then(doc => _create(doc.data().text))
            .catch(console.error)
          lastEditorChangeTime = 0
          onEditorChange('')
          return
        }
        case '/_tweet': {
          if (editingItems.length == 0) return alert('/_tweet: no item selected')
          if (editingItems.length > 1) return alert('/_tweet: too many items selected')
          let item = items[editingItems[0]]
          location.href = 'twitter://post?message=' + encodeURIComponent(item.text)
          return
        }
        case '/_duplicate': {
          if (editingItems.length == 0) return alert('/_duplicate: no item selected')
          if (editingItems.length > 1) return alert('/_duplicate: too many items selected')
          let item = items[editingItems[0]]
          time = item.time
          text = item.text
          editing = true
          break
        }
        case '/_undelete': {
          if (deletedItems.length == 0) return alert('/_undelete: nothing to undelete (in this session)')
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
              .replace(/[`\\$]/g, '\\$&')
              .trim()
            // for commands we provide whitespace-split args as additional arguments
            const cmd_args = [args, ...args.split(/\s+/)].map(arg => `\`${arg}\``)

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
              getDocs(
                query(
                  collection(getFirestore(firebase), 'items'),
                  where('user', '==', 'anonymous'),
                  orderBy('time', 'desc')
                )
              )
                .then(examples => {
                  console.log(`/_example: retrieved ${examples.docs.length} example items`)
                })
                .catch(console.error)
              return
            } else if (cmd == '/_watch') {
              if (hostname != 'localhost') return alert(`/_watch: can not watch on ${hostname}`)
              let [name, file] = args.split(/\s+/)
              if (!name || !file) return alert(`usage: ${cmd} name file`)
              // look up item
              const item = _item(name)
              if (!item) return alert(`${cmd}: item '${name}' missing or ambiguous`)
              ;(async () => {
                try {
                  // look up file
                  const resp = await fetch(`/file/${file}`)
                  if (!resp.ok) return alert(`${cmd}: failed to fetch file '${file}'`)
                  const text = await resp.text()
                  if (text != item.text) return alert(`${cmd}: contents of file ${file} does not match item ${name}`)
                  console.debug(`watching file ${file} for item ${name} ...`)
                  item.dispatch_task(
                    `${cmd} ${file}`,
                    async () => {
                      const resp = await fetch(`/file/${file}`)
                      if (!resp.ok) {
                        console.error(`${cmd}: failed to fetch file '${file}'`)
                        return
                      }
                      const text = await resp.text()
                      if (text != item.text) {
                        console.debug(`detected changes to ${file} for item ${name}`)
                        item.write(text, '')
                      }
                    },
                    0,
                    1000
                  )
                } catch (e) {
                  console.error(`${cmd}: failed to read file ${file}: ` + e)
                  return alert(`${cmd}: failed to read ${file}: ` + e)
                }
              })()
              lastEditorChangeTime = 0 // disable debounce even if editor focused
              onEditorChange('')
              return
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
              if (!path) return alert(`usage: ${cmd} path [repo branch owner token]`)
              // drop optional leading slash in paths for consistency
              if (path.startsWith('/')) path = path.substring(1)
              if (path.startsWith('/')) return alert(`invalid path '${path}'`)
              // if path is specified as #label, extract path from named item
              // note path==label is not required in general, indeed labels could be missing or non-unique
              // however path==label is required for dependencies (see below) so their paths can be inferred
              let label
              if (path.startsWith('#')) {
                label = path
                if (idsFromLabel.get(label.toLowerCase())?.length > 1)
                  return alert(`can not update multiple items labeled ${label}`)
                else if (!_exists(label)) return alert(`missing item ${label}`)
                path = _item(label).attr.path
              }
              // check file extension in path
              // default (and preferred) extension is .md for installable items
              // .markdown is also supported but preferred more for sync/backup/export purposes
              if (!path.includes('.')) path += '.md'
              else if (!path.endsWith('.md') && !path.endsWith('.markdown'))
                return alert(`${cmd}: invalid file extension in path '${path}'`)

              // distinguish "root" vs dependency installation
              // we use a global 'installing' flag, which MUST be reset on return by root
              // any returns below should be for non-root only, or inside a try/finally block
              const root = !installing // root (vs dependency) installation
              installing = true // set to false in finally block of root command

              // if root command, initialize dependency set to de-duplicate indirect dependencies
              // otherwise add the dependency set, or cancel if already added
              if (root) installed_dependencies = new Set()
              else {
                if (installed_dependencies.has(path)) {
                  console.debug(`${cmd}: skipping already-${updating ? 'updated' : 'installed'} dependency at ${path}`)
                  lastEditorChangeTime = 0 // disable debounce even if editor focused
                  onEditorChange('')
                  // note item label is dependency path minus default .md suffix
                  return _item('#' + path.replace(/\.md$/, '')) // return dependency
                }
                installed_dependencies.add(path)
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
                    await _modal_close() // close/cancel all modals
                    token = await _modal({
                      content: `MindPage needs your [Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token) to install or update items from GitHub. Token is required even for public repos to avoid strict rate limits imposed on token-free access by GitHub.`,
                      confirm: 'Use Token',
                      cancel: 'Cancel',
                      input: '',
                      password: false,
                    })
                    if (token) localStorage.setItem('mindpage_github_token', token)
                    // else token = null // no token, use unauthenticated client
                    else return // cancelled
                  }
                  // NOTE: force-closing modals is especially important since install/update can be invoked recursively for dependencies ...
                  await _modal_close() // close/cancel all modals
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
                  let text = decode_base64(data.content)

                  // parse label from text
                  // if path was specified as #label, then parsed label must match
                  const parsed_label = parseLabel(text)
                  if (label && label != parsed_label) {
                    throw new Error(
                      `${cmd}: parsed label '${parsed_label}' for ${path} does not match specified label '${label}'`
                    )
                  }
                  // if installing/updating a dependency, then specified path (minus default suffix .md) must match parsed label
                  if (dependents.length && parsed_label.slice(1) + '.md' != path) {
                    throw new Error(
                      `${cmd}: parsed label '${parsed_label}' is invalid for dependency at ${path} for dependents ${dependents.join(
                        ' <- '
                      )}`
                    )
                  }
                  label = parsed_label
                  // if updating, label must uniquely match an existing (named) item
                  if (updating) {
                    if (!label) throw new Error(`${cmd}: could not determine item name for update from ${path}`)
                    else if (idsFromLabel.get(label.toLowerCase())?.length > 1)
                      throw new Error(`${cmd}: found multiple items labeled ${label}, can not update from ${path}`)
                    else if (!_exists(label)) throw new Error(`${cmd}: missing item ${label} to update from ${path}`)
                  }

                  const attr = {
                    sha,
                    editable: false,
                    pushable: false,
                    source: `https://github.com/${owner}/${repo}/blob/${branch}/${path}`,
                    path,
                    repo,
                    branch,
                    owner,
                    token /* to authenticate for updates */,
                    embeds: null, // may be filled in below
                    shared: null, // used separately for sharing
                  }

                  // extract embed paths
                  let embeds = []
                  for (let [m, sfx] of text.matchAll(/(?:^|\n) *```\S+:(\S+?)\n(.*?)\n```/gs))
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
                      embed_text[path] = decode_base64(data.content)
                      attr.embeds = (attr.embeds ?? []).concat({ path, sha })
                    } catch (e) {
                      throw new Error(`failed to embed '${path}'; error: ${e}`)
                    }
                  }
                  // replace embed block body with embed contents
                  text = text.replace(/((?:^|\n) *)```(\S+):(\S+?)\n(.*?)\n```/gs, (m, mpfx, pfx, sfx, body) => {
                    if (sfx.includes('.')) {
                      const path = resolve_embed_path(sfx, attr)
                      // store original body in attr.embeds to allow item to be edited and pushed back
                      // note if same path is embedded multiple times, only the last body is retained
                      attr.embeds.find(e => e.path == path).body = body
                      return mpfx + '```' + pfx + ':' + sfx + '\n' + embed_text[path] + '\n```'
                    }
                    return m
                  })

                  // install missing dependencies based on item text
                  // all tags (not just hidden tags) are considered dependencies
                  // dependency paths MUST match the (resolved) hidden tags
                  if (label) {
                    const deps = resolveTags(
                      label,
                      parseTags(text).all.filter(t => t != label && !isSpecialTag(t))
                    )
                    for (let dep of deps) {
                      if (_exists(dep)) continue // already installed
                      const dep_path = dep.slice(1) // path assumed same as tag
                      if (dep_path.startsWith('/'))
                        // should not happen w/ resolved tags
                        throw new Error('invalid dependency path: ' + dep_path)
                      // skip circular dependencies
                      if (dependents.includes(dep)) {
                        console.debug(`${cmd}: skipping circular dependency ${dep} for ${label}`)
                        continue
                      }
                      console.debug(`installing dependency ${dep} for ${label} ...`)
                      const command = `/_install ${dep_path} ${repo} ${branch} ${owner} ${token || ''} <- ${[
                        label,
                        ...dependents,
                      ].join(' <- ')}`
                      const dep_item = await onEditorDone(command)
                      if (!dep_item) {
                        throw new Error(`${cmd}: failed to install dependency ${dep} for ${label}`)
                      } else if (dep_item.name.toLowerCase() != dep.toLowerCase()) {
                        // name/path consistency should be enforced by _install
                        throw new Error(
                          `${cmd}: invalid name ${dep_item.name} for installed dependency ${dep} of ${label}`
                        )
                      }
                    }
                  }

                  // replace existing item or create new item
                  let item // item being updated/installed
                  if (label && _exists(label, false /*allow_multiple*/)) {
                    // confirm replacement if installing
                    if (!updating) {
                      await _modal_close() // close/cancel all modals
                      const replace = await _modal({
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
                    if (updating && item.pushable && item.text != text) {
                      await _modal_close() // close/cancel all modals
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
                    // maintain pushable, editable & shared flags before replacing attr
                    attr.pushable = item.pushable
                    attr.editable = item.editable
                    attr.shared = _.cloneDeep(item.shared)
                    __item(item.id).attr = attr
                    item.write(text, '')
                  } else {
                    item = _create(text, {}, attr)
                  }

                  // wait for dom update
                  await update_dom()

                  // invoke _on_install(item)|_on_update(item) if defined as function
                  if (!updating) {
                    if (itemDefinesFunction(item, '_on_install')) {
                      Promise.resolve(
                        _item(item.id).eval(`_on_install(_item('${item.id}'))`, {
                          trigger: 'install',
                          async: item.deepasync, // run async if item is async or has async deps
                          async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
                        })
                      ).catch(e => {}) // already logged
                    }
                  } else {
                    if (itemDefinesFunction(item, '_on_update')) {
                      Promise.resolve(
                        _item(item.id).eval(`_on_update(_item('${item.id}'))`, {
                          trigger: 'update',
                          async: item.deepasync, // run async if item is async or has async deps
                          async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
                        })
                      ).catch(e => {}) // already logged
                    }
                  }

                  // reset editability to discourage editing after updating to remote state
                  item.editable = false

                  // log completion and return item to indicate successful install/update
                  console.debug(
                    (updating ? 'updated' : 'installed') + ` ${path} (${item.name}) in ${Date.now() - start}ms`
                  )

                  // start watching repo path (if not already being watched) for newly installed item
                  if (!updating) watchLocalRepo(item.attr.repo)

                  // if this is root command, finalize modals and trigger push if needed
                  if (root) {
                    await _modal_close() // close/cancel all modals
                    await _modal({
                      content: `${updating ? 'Updated' : 'Installed'} ${item.name}`,
                      confirm: 'OK',
                      background: 'confirm',
                    })
                    // also push item if it was marked pushable
                    // #pusher should exist since it sets pushable, but we check anyway ...
                    if (item.pushable) {
                      if (_item('#pusher')) onEditorDone('/push ' + item.name)
                      else console.error(`${cmd}: unable to push item ${item.name} due to missing (deleted?) #pusher`)
                      // item.pushable = false // clear flag even if push command failed
                    }
                    // ask about reloading for changes to init/welcome items ...
                    const reload_items = items.filter(i => i.shouldReload).map(i => i.name)
                    if (reload_items.length) {
                      const s = reload_items.length > 1 ? 's' : ''
                      const ns = reload_items.length > 1 ? '' : 's'
                      const reload = await _modal({
                        content: `MindPage recommends reloading page for ${
                          reload_items.length
                        } new (or updated) item${s} that contain${ns} [init](https://mindbox.io/#features/_init) or [welcome](https://mindbox.io/#features/_welcome) code: ${reload_items.join(
                          ', '
                        )}`,
                        confirm: 'Reload',
                        cancel: 'Skip',
                        background: 'confirm',
                      })
                      if (reload) location.reload()
                    }
                  }

                  return item
                } catch (e) {
                  console.error(`${updating ? 'update' : 'install'} failed for ${path}: ` + e)
                  // close/cancel all modals on error (even if non-root command)
                  await _modal_close()
                  return alert(`${updating ? 'update' : 'install'} failed for ${path}: ` + e)
                } finally {
                  // close/cancel modals and clear installing flag for root command
                  if (root) {
                    await _modal_close()
                    installing = false
                  }
                }
              })())
            } else if (_exists('#commands' + cmd)) {
              const start = Date.now()
              function handleError(e) {
                const log = _item('#commands' + cmd).get_log({ since: start, level: 'error' })
                let msg = [`#commands${cmd} run(${cmd_args}) failed:`, ...log, e].join('\n')
                return alert(msg)
              }
              try {
                let cmd_item = items[_item('#commands' + cmd).index]
                // return promise so caller can wait for command output
                return (window['_mindbox_return'] = Promise.resolve(
                  _item('#commands' + cmd).eval(`run(${cmd_args})`, {
                    trigger: 'command',
                    async: cmd_item.deepasync, // run async if item is async or has async deps
                    async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
                  })
                )
                  .then(obj => handleCommandReturn(cmd, cmd_item, obj, run, editing, return_alerts, handleError))
                  .catch(handleError))
              } catch (e) {
                handleError(e)
                throw e
              }
            } else {
              // as last effort, invoke on first listener that defines _on_command_<name>
              let found_listener = false
              for (let item of items) {
                if (!item.listen) continue
                const name = cmd.substring(1)
                if (!itemDefinesFunction(item, '_on_command_' + name)) continue
                found_listener = true
                const start = Date.now()
                function handleError(e) {
                  const log = _item(item.id).get_log({ since: start, level: 'error' })
                  let msg = [`${item.name} _on_command_${name}(${cmd_args}) failed: `, ...log, e].join('\n')
                  return alert(msg)
                }
                const ret = _item(item.id).eval(`return _on_command_${name}(${cmd_args})`, {
                  trigger: 'listen',
                  async: item.deepasync, // run async if item is async or has async deps
                  async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
                })
                // return promise so caller can wait for command output
                return (window['_mindbox_return'] = Promise.resolve(ret)
                  .then(obj => handleCommandReturn(cmd, item, obj, run, editing, return_alerts, handleError))
                  .catch(handleError))
              }
              return alert(`unknown command ${cmd} ${args}`)
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
    if (fixed) {
      alert('can not create new item when viewing shared items')
      return
    }

    let itemToSave = { user: user.uid, time, attr, text }
    let item = initItemState(_.clone(itemToSave), 0, {
      id: (Date.now() + sessionCounter++).toString(), // temporary id for this session only
      editing: editing,
      saving: !editing,
      savedId: null, // filled in below after save
      savedTime: 0, // filled in onItemSaved
      savedAttr: null, // filled in onItemSaved
      savedText: '', // filled in onItemSaved (also means delete on cancel & skip confirm on delete)
    })
    items = [item, ...items]

    // update indices as needed by itemTextChanged
    indexFromId = new Map<string, number>()
    items.forEach((item, index) => indexFromId.set(item.id, (item.index = index)))
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
        // restoreItemEditor(item.id)

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
        if (!itemDefinesFunction(item, '_on_create')) return
        Promise.resolve(
          _item(item.id).eval(`_on_create(\`${editorText.replace(/[`\\$]/g, '\\$&')}\`)`, {
            trigger: 'listen',
            async: item.deepasync, // run async if item is async or has async deps
            async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
          })
        ).catch(e => {}) // already logged
      })
    })

    encryptItem(itemToSave)
      .then(itemToSave => {
        ;(readonly
          ? Promise.resolve({ id: item.id, delete: Promise.resolve /* dummy promise */ })
          : addDoc(collection(getFirestore(firebase), 'items'), itemToSave)
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
              addDoc(collection(getFirestore(firebase), 'history'), { item: doc.id, ...itemToSave }).catch(
                console.error
              )
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
      item.savingText = null
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
    if (index == undefined) return // item was deleted
    let item = items[index]
    // exclude any ._log elements since they are usually collapsed
    let logHeight = 0
    container.querySelectorAll('._log').forEach(log => (logHeight += log.offsetHeight))
    const height = container.offsetHeight - logHeight
    const prevHeight = item.height
    if (prevHeight == 0) {
      if (height <= 0) console.warn(`invalid height (${height}) for item ${item.name} at index ${index}`)
      else {
        item.resolve_height?.(height)
        item.resolve_height = null
      }
    }
    // count number of elements that will trigger additional resizes
    // if height>0 and no more resizes are expected, set rendered=true & invoke resolve_render (if set up)
    // otherwise reset rendered=false, typically due to re-render w/ pendingElems>0 (height=0 would trigger warning)
    item.pendingElems = container.querySelectorAll(
      ['script', 'img:not([_rendered])', ':is(span.math,span.math-display):not([_rendered])'].join()
    ).length
    let just_rendered = false
    if (height > 0 && item.pendingElems == 0) {
      just_rendered = !item.rendered
      item.rendered = true
      item.resolve_render?.(container.closest('.super-container'))
      item.resolve_render = null
    } else if (item.rendered) {
      item.rendered = false
    }

    if (height == prevHeight && !just_rendered) return // nothing has changed
    if (height <= 0 && prevHeight > 0) {
      console.warn(`ignoring invalid height ${height} (was ${prevHeight}) for item ${item.name} at index ${index}`)
      return
    }
    // console.debug(`item ${item.name} height changed from ${prevHeight}} to ${height}`);

    item.height = height

    // NOTE: Heights can fluctuate due to async scripts that generate div contents (e.g. charts), especially where the height of the output is not known and can not be specified via CSS, e.g. as an inline style on the div. We tolerate these changes for now, but if this becomes problematic we can skip or delay some layout updates, especially when the height is decreasing, postponing layout update to other events, e.g. reordering of items.
    if (
      just_rendered ||
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
    if (autohide_after >= 0) {
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
    // if js_input block is missing (not just empty), then we depend on _run function handling a non-js input block (otherwise item should not be marked runnable) so we output an error message if _run function is missing
    if (!jsin && !item.lctext.match(blockRegExp('js_input(?:_hidden|_removed)? *'))) {
      jsin = `if (typeof _run != 'function') console.error('missing _run function for non-js _input block; enabling #_tag may be missing (e.g. #_typescript for ts_input)')`
    }
    // always defer to _run function if defined, even if there is js_input (for custom handling of js code), but allow skipping by returning null
    // note this does not apply to debug items which already contain complete run/eval logic from a prior run/eval
    if (!item.debug)
      jsin = [`if (typeof _run == 'function') { const out = _run(); if (out !== null) return out }`, jsin].join('\n')
    jsin = jsin.trim()
    // if (!jsin) return item.text // input missing or empty, ignore
    let jsout
    const start = Date.now()
    try {
      jsout = _item(item.id).eval(jsin, { debug: item.debug, async, trigger: 'run' /*|create*/ })
    } catch (e) {} // already logged, just continue
    // ignore output if Promise
    if (jsout instanceof Promise) jsout = undefined
    // stringify output
    if (jsout !== undefined && typeof jsout != 'string') jsout = '' + stringify(jsout)
    const outputConfirmLength = 256 * 1024
    if (jsout !== undefined && jsout.length >= outputConfirmLength)
      if (!confirm(`Write ${jsout.length} bytes (_output) into ${item.name}?`)) jsout = undefined
    // append _output and _log and update for changes
    if (jsout !== undefined) item.text = appendBlock(item.text, '_output', jsout)
    // instead of write_log we can appendBlock to avoid triggering an extra save
    // _item(item.id).write_log() // auto-write log
    const log = _item(item.id).get_log({ since: start }).join('\n')
    if (log) {
      item.text = appendBlock(item.text, '_log', log)
      _item(item.id).show_logs()
    }
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
    item.savingText = item.text
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
      // console.debug('saving item', itemToSave)
      updateDoc(doc(getFirestore(firebase), 'items', item.savedId), itemToSave)
        .then(() => onItemSaved(item.id, itemToSave))
        .catch(console.error)

      // also save to history ...
      addDoc(collection(getFirestore(firebase), 'history'), {
        item: item.savedId,
        user: user.uid,
        ...itemToSave,
      }).catch(console.error)
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

  function deleteItem(index, confirm_delete = undefined): boolean {
    if (fixed) {
      _modal('can not delete item when viewing shared items')
      return false
    }
    const item = items[index]
    // by default, confirm if item has saved text (not new item) & unique label
    confirm_delete ??= item.savedText && item.labelUnique
    if (confirm_delete && !confirm(`Delete ${item.name}?`)) return false
    const { name } = item // name used below
    itemTextChanged(index, '') // clears label, deps, etc
    items.splice(index, 1)
    if (index < hideIndex) hideIndex-- // back up hide index
    // update indices as needed by onEditorChange
    indexFromId = new Map<string, number>()
    items.forEach((item, index) => indexFromId.set(item.id, (item.index = index)))
    // deletion can affect ordering (e.g. due to missingTags), so we need onEditorChange
    // we also clear query if deleted item was being navigated
    if (editorText.trim().toLowerCase() == name.toLowerCase()) {
      replaceStateOnEditorChange = true // do not create new entry
      editorText = ''
    }
    lastEditorChangeTime = 0 // disable debounce even if editor focused
    onEditorChange(editorText)
    deletedItems.unshift({
      time: item.savedTime,
      attr: _.cloneDeep(item.savedAttr),
      text: item.savedText,
    }) // for /undelete
    if (!readonly && item.savedId) deleteDoc(doc(getFirestore(firebase), 'items', item.savedId)).catch(console.error)

    // if deleted item was being navigated, go back to previous state
    // if (navigated && sessionStateHistoryIndex > 0) update_dom().then(() => history.back())
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

    // if cancelled, restore savedText (or savingText if saving)
    // we do not restore time so item remains "soft touched"
    // we also do not restore attr
    if (cancelled) {
      // confirm cancellation when there are unsaved changes and item is not already saving
      if (item.text != item.savedText && !item.saving && !confirm(`Discard changes to ${item.name}?`)) {
        item.editing = true
        return
      }
      // item.time = item.savedTime;
      // item.attr = _.cloneDeep(item.savedAttr);
      item.text = item.saving ? item.savingText : item.savedText
    }

    // check for deletion triggered by editor, which can be cancelled via confirmation
    // we only confirm if item is not already emptied out, which triggers deletion automatically
    if (item.text.trim() && e['_delete']) {
      if (confirm(`Delete ${item.uniqueLabel || 'item'}?`)) {
        item.text = '' // will trigger unconfirmed deletion below
      } else {
        item.editing = true
        return
      }
    }

    // check for deletion by emptying out item, which is disallowed in fixed mode
    if (item.text.trim().length == 0 && fixed) {
      _modal('can not delete item when viewing shared items').then(() => textArea(item.index)?.focus())
      item.editing = true
      return
    }

    if (editing) {
      // started editing
      editingItems.push(index)
      lastEditorChangeTime = 0 // disable debounce even if editor focused
      onEditorChange(editorText) // editing state (and possibly time) has changed
      // retreat to minimal hide index to focus on edited item
      // hideIndex = hideIndexMinimal
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
        // delete empty item w/o confirmation
        deleteItem(index, false /* confirm_delete */)
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
        update_dom().then(() => {
          const div = document.querySelector('#super-container-' + item.id)
          if (!div) return // item deleted or hidden
          const itemTop = (div as HTMLElement).offsetTop
          if (itemTop < document.body.scrollTop)
            scrollTo(Math.max(headerdiv.offsetTop, itemTop - visualViewport.height / 4))
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

    // preview all previewable items before running
    const pending_previews = items.filter(item => item.previewable).map(previewItem)
    if (pending_previews.length) {
      Promise.all(pending_previews).then(() => onItemRun(item.index, touch_first))
      return
    }

    // create separate "run item" for installed items
    if (item.attr?.source) {
      if (!item.name.startsWith('#')) {
        _modal('cannot run unnamed installed item')
        return
      }
      const run_name = item.name + '/run'
      let run_item = _item(run_name, { silent: true })

      // copy only input blocks, prepend label and dependency on parent
      const input_regex = blockRegExp('\\S+_input *') // input type is required as w/ runnable flag
      let run_text =
        run_name + ' ' + item.label.replace(/^#/, '#_') + '\n' + item.text.match(input_regex).join('\n').trim()

      // hide input blocks (via _removed suffix)
      run_text = run_text.replace(input_regex, m => m.replace(/_input/, '_input_removed'))

      // focus on run item (w/o scrolling) unless it (or a descendant) is already focused
      if (!editorText.trim().toLowerCase().startsWith(run_name.toLowerCase())) {
        const wasScrollingDisabled = disableScrollingOnLayout
        disableScrollingOnLayout = true
        lastEditorChangeTime = 0 // force immediate update
        forceNewStateOnEditorChange = true // force new state
        onEditorChange(run_name)
        disableScrollingOnLayout = wasScrollingDisabled
        // in case code depends on mindbox text, update it now
        // alternative is to dispatch the running pending on dom update
        textArea(-1).value = run_name
      }

      if (!run_item) {
        run_item = _create(run_text, { run: true })
        if (!run_item) throw new Error('failed to create new item to run')
      } else {
        // if js_input modified, confirm overwrite
        if (
          hash(run_item.read('js_input')) != _item(item.id).global_store.run_hash &&
          !confirm(`Overwrite changes in js_input block in ${run_name}?`)
        )
          return
        run_item.write(run_text, '' /* replace whole item */)
        onItemRun(run_item.index, touch_first)
      }
      // store hash of js_input to detect changes to js_input block in run item
      _item(item.id).global_store.run_hash = hash(run_item.read('js_input'))
      return
    }

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
      update_dom().then(runItem)
    }
  }

  function onItemTouch(index: number, e: MouseEvent = null) {
    if (items[index].log && !confirm(`Modify time for #log item?\ncreation time/ordering will be lost`)) return
    // if (items[index].time > newestTime) console.warn('invalid item time')
    if (items[index].time > newestTime) newestTime = items[index].time
    if (e?.altKey && e?.metaKey) {
      // move item time back 1 day
      items[index].time = items[index].time - 24 * 3600 * 1000
    } else if (e?.altKey) {
      if (index == items.length - 1 || items[index].time < items[index + 1].time) {
        _modal('can not move item down')
        return
      }
      items[index].time = items[index + 1].time - 1
    } else if (e?.metaKey) {
      if (index == 0 || items[index].time > items[index - 1].time) {
        _modal('can not move item up')
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
      _modal(`can not push ${items[index].name}, #pusher must be installed first`)
      return
    }
    onEditorDone('/push ' + items[index].name)
  }

  function onItemPreview(index: number) {
    previewItem(items[index])
  }

  function editItem(index: number) {
    items[index].editing = true
    editingItems.push(index)
  }

  function restoreItemEditor(id) {
    update_dom().then(() => {
      const textarea = textArea(indexFromId.get(id))
      if (!textarea) return
      textarea.focus()

      // calculate caret position
      // NOTE: following logic was originally used to detect caret on first/last line, see https://github.com/olcan/mind.page/blob/94653c1863d116662a85bc0abd8ea1cec042d2c4/src/components/Editor.svelte#L294
      const backdrop = textarea.closest('.editor')?.querySelector('.backdrop')
      if (!backdrop) return // unable to locate backdrop div for caret position
      const clone = backdrop.cloneNode(true) as HTMLDivElement
      clone.style.visibility = 'hidden'
      backdrop.parentElement.insertBefore(clone, backdrop)
      ;(clone.firstChild as HTMLElement).innerHTML =
        _.escape(textarea.value.substring(0, textarea.selectionStart)) +
        `<span>${_.escape(textarea.value.substring(textarea.selectionStart) || ' ')}</span>`
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
      // waiting for dom update significantly improves consistency on ios, likely due to toggling of items below, e.g. due to editing mode change (which can also be revisited if there are other similar issues)
      update_dom().then(() => {
        if (caretTop < document.body.scrollTop || caretTop > document.body.scrollTop + visualViewport.height - 200)
          scrollTo(Math.max(0, caretTop - visualViewport.height / 4))
      })
    })
  }

  let lastEditItem
  function resumeLastEdit() {
    if (!lastEditItem) return
    let index = indexFromId.get(lastEditItem)
    if (index === undefined) return
    if (index >= hideIndex) {
      _modal(`last edited item ${items[index].name} is currently hidden; try going back or revealing more items`)
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
    if (!headerdiv) return
    // adjust header button text based on scroll position if visible
    const y = document.body.scrollTop - headerdiv.offsetTop
    if (y < 24) {
      document.querySelectorAll('.header .button').forEach((button: HTMLElement) => {
        const top_padding = 15 + Math.max(Math.min(0, y), -8)
        button.style.paddingTop = top_padding + 'px'
        button.style.paddingBottom = 15 - top_padding + 'px'
      })
    }

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
        replaceState(Object.assign(history.state, { scrollPosition: document.body.scrollTop }))
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
      _modal('can not minimize items while editing')
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
    if (!e.message && e.error) return stringify(e)
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
        : // if we have a stack trace instead of line/column, we attach it to message unless it already has '; STACK:…'
        e.stack && !e.message.match(/; STACK:/)
        ? // NOTE: slice(1) skips the error message itself, which seems to be included in the stack
          `${e.message}; STACK: ${e.stack.split(/\n\s*/g).slice(1).join(' <- ').replace(/\s+/g, ' ')}`
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

  let watching = new Set()
  async function watchLocalRepo(repo) {
    if (hostname != 'localhost') return // can not watch outside localhost
    if (watching.has(repo)) return // already watching repo
    // fetch initial previews from local repo
    console.debug(`fetching previews from local repo ${repo} ...`)
    const start = Date.now()
    for (const item of items) {
      if (!item.attr?.source) continue // item not installed
      if (item.attr.repo != repo) continue // item not from modified local repo
      await fetchPreview(item)
    }
    console.debug(`fetched previews from local repo ${repo} in ${Date.now() - start}ms`)
    // start watching
    watching.add(repo)
    _watchLocalRepo(repo)
    console.debug(`watching local repo ${repo} ...`)
  }
  async function _watchLocalRepo(repo) {
    try {
      const resp = await fetch(`/watch/${initTime}/${repo}`)
      if (!resp.ok) {
        console.warn(`error watching local repo ${repo}: ${resp.statusText}; will retry in 10s ...`)
        setTimeout(() => _watchLocalRepo(repo), 10000)
        return
      }
      const events = await resp.json()
      const changed_paths = _.uniq(events.filter(e => e.event == 'change').map(e => e.path.replace(/^\//, '')))
      for (const changed_path of changed_paths) {
        console.debug(`detected change in local repo path ${changed_path}`)
        for (const item of items) {
          if (!item.attr?.source) continue // item not installed
          if (item.attr.repo != repo) continue // item not from modified local repo
          const attr = item.attr
          // calculate item paths, including any embeds, removing slash prefixes
          const paths = [attr.path, ...(attr.embeds?.map(e => e.path) ?? [])].map(path => path.replace(/^\//, ''))
          if (paths.includes(changed_path)) await fetchPreview(item)
        }
      }
      setTimeout(() => _watchLocalRepo(repo), 1000)
    } catch (e) {
      console.warn(`error watching local repo ${repo}: ${e}; will retry in 10s...`)
      setTimeout(() => _watchLocalRepo(repo), 10000)
    }
  }

  function resolve_embed_path(path, attr) {
    if (path.startsWith('/') || !attr.path.includes('/', 1)) return path
    return attr.path.substr(0, attr.path.lastIndexOf('/')) + '/' + path
  }

  async function fetchPreview(item) {
    const start = Date.now()
    const attr = item.attr
    const { repo, path } = attr
    try {
      // fetch text from from local repo via server
      const resp = await fetch(`/file/${repo}/${path}`)
      if (!resp.ok) throw new Error(`failed to fetch file '${path}': ${resp.statusText}`)
      let text = await resp.text()

      // extract embed paths from updated text
      // number of embeds can change here if item text is updated
      let embeds = []
      for (let [m, sfx] of text.matchAll(/(?:^|\n) *```\S+:(\S+?)\n(.*?)\n```/gs))
        if (sfx.includes('.')) embeds.push(resolve_embed_path(sfx, attr))

      // fetch embed text from local repo via server
      // also update attr.embeds based on preview text
      const prev_embeds = attr.embeds
      attr.embeds = null
      let embed_text = {}
      for (let path of _.uniq(embeds)) {
        try {
          const resp = await fetch(`/file/${repo}/${path}`)
          if (!resp.ok) throw new Error(`failed to fetch file '${path}': ${resp.statusText}`)
          embed_text[path] = await resp.text()
          const sha = prev_embeds?.find(e => e.path == path)?.sha ?? null // remote sha if exists, null if new embed
          attr.embeds = (attr.embeds ?? []).concat({ path, sha })
        } catch (e) {
          throw new Error(`failed to embed '${path}': ${e}`)
        }
      }

      // replace embed block body with (updated) embed text
      text = text.replace(/((?:^|\n) *)```(\S+):(\S+?)\n(.*?)\n```/gs, (m, mpfx, pfx, sfx, body) => {
        if (!sfx.includes('.')) return m // not path
        const path = resolve_embed_path(sfx, attr)
        // store original body in attr.embeds
        // only last body is retained for multiple embeds of same path
        attr.embeds.find(e => e.path == path).body = body
        return mpfx + '```' + pfx + ':' + sfx + '\n' + embed_text[path] + '\n```'
      })

      // save preview text on item for previewItem()
      const was_previewable = item.previewable
      item.previewText = text
      item.previewable = item.previewText != item.text
      if (item.previewable) {
        // auto-preview if non-blank non-comment lines are unchanged across all code blocks
        // also need label & dependencies (all tags, not just hidden) to be unchanged
        // also need non-block lines to be unchanged
        const requires_manual_preview = line => line.trim() && !line.match(/^ *\/\//)
        if (
          _.isEqual(
            extractBlock(item.text, '\\S*').split('\n').filter(requires_manual_preview),
            extractBlock(item.previewText, '\\S*').split('\n').filter(requires_manual_preview)
          ) &&
          _.isEqual(parseLabel(item.text), parseLabel(item.previewText)) &&
          _.isEqual(parseTags(item.text).all, parseTags(item.previewText).all) &&
          _.isEqual(removeBlock(item.text, '\\S*'), removeBlock(item.previewText, '\\S*'))
        )
          await previewItem(item)
      }
      // if previewability changed, trigger re-ranking since affected
      if (item.previewable != was_previewable) {
        lastEditorChangeTime = 0 // disable debounce even if editor focused
        onEditorChange(editorText)
      }
      console.debug(`fetched preview for ${item.name} from ${repo}/${path} in ${Date.now() - start}ms`)
    } catch (e) {
      const msg = `failed to fetch preview for ${item.name} from ${repo}/${path}: ${e}`
      console.error(msg)
      _modal(msg)
    }
  }

  async function previewItem(item) {
    if (!item.previewable) throw new Error('item not previewable')
    if (!item.previewText) throw new Error('preview item missing preview text')
    if (item.text == item.previewText) throw new Error('item marked previweable w/o changes')
    if (!item.attr?.source) throw new Error('preview item not an installed item')
    const attr = item.attr
    const { repo, path } = attr
    const text = item.previewText

    // confirm preview if item has non-preview changes
    if (
      item.pushable &&
      item.text != item.previewText &&
      item.local_store?._preview_hash && // may be first preview, or reset due to remote changes
      hash(item.text) != item.local_store._preview_hash &&
      !(await _modal_confirm(`Item ${item.name} has non-preview changes. Overwrite to preview anyway?`))
    ) {
      console.warn(`cancelled preview for ${item.name} from ${repo}/${path} due to non-preview changes`)
      return
    }

    // disallow renaming preview
    const parsed_label = parseLabel(text)
    if (parsed_label != item.name) {
      _modal(
        `preview failed: parsed label '${parsed_label}' does not match current name ${item.name} for preview from ${repo}/${path}`
      )
      return
    }

    // install missing "dependencies" based on updated text
    // all tags (not just hidden tags) are considered dependencies
    // dependency paths MUST match the (resolved) hidden tags
    const label = parseLabel(text)
    if (label) {
      const deps = resolveTags(
        label,
        parseTags(text).all.filter(t => t != label && !isSpecialTag(t))
      )
      for (let dep of deps) {
        if (_exists(dep)) {
          if (!_exists(dep, false /*allow_multiple*/))
            console.warn(`invalid (ambiguous) preview dependency ${dep} for ${label}`)
          continue
        }
        console.debug(`installing preview dependency ${dep} for ${label} ...`)
        const dep_path = dep.slice(1) // path assumed same as tag
        const command = `/_install ${dep_path} ${repo} ${attr.branch} ${attr.owner} ${attr.token || ''} <- ${label}`
        const dep_item = await onEditorDone(command)
        if (!dep_item) {
          throw new Error(`failed to install preview dependency ${dep} for ${label}`)
        } else if (dep_item.name.toLowerCase() != dep.toLowerCase()) {
          // name/path consistency should be enforced by _install for dependency
          throw new Error(`invalid name ${dep_item.name} for installed dependency ${dep} of ${label}`)
        }
        console.debug(`installed preview dependency ${dep} for ${label}`)
      }
    }

    item.pushable = true // mark pushable until pushed
    item.previewable = false // update before write
    const prev_name = item.name
    _item(item.id).write(text, '' /*, { keep_time: true }*/)
    if (item.name != prev_name) console.warn(`preview renamed ${item.name} (was ${prev_name}) from ${repo}/${path}`)
    item.previewable = item.text != item.previewText // should remain false
    // store preview text hash to be able to detect non-preview changes across reloads
    _item(item.id).local_store._preview_hash = hash(item.previewText)
    console.debug(`previewed ${item.name} from ${repo}/${path}`)
  }

  import { onMount } from 'svelte'
  import {
    extractBlock,
    blockRegExp,
    tagRegex,
    parseTags,
    parseLabel,
    replaceTags,
    renderTag,
    isBalanced,
    invalidateElemCache,
    checkElemCache,
    skipEscaped,
    byteArrayToString,
    byteStringToArray,
    concatByteArrays,
    stringify,
    byte_stringify,
    encode,
    encode_utf8,
    encode_utf8_array,
    encode_byte_array,
    encode_base64,
    decode,
    decode_utf8,
    decode_utf8_array,
    decode_byte_array,
    decode_base64,
    hash,
    hash_32_djb2,
    hash_32_fnv1a,
    hash_32_murmur3,
    hash_52_fnv1a,
    hash_64_fnv1a,
    hash_128_murmur3_x64,
    hash_128_murmur3_x86,
    hash_160_sha1,
  } from '../util.js'

  let consoleLog = []
  const consoleLogMaxSize = 10000
  const statusLogExpiration = 15000

  // returns true iff item defines specified function _without_ any dependencies
  // needed to avoid invoking callback functions (e.g. _on_item_change) on dependents that only mention the function name in comments or strings, forcing confusing checks (e.g. of _this.id or _this.name) in implementations
  function itemDefinesFunction(item, name, options = {}) {
    if (item.debug) return false // debug item should be excluded from all definition checks (and hook invocations)
    if (!item.text.includes(name)) return false // quick check
    if (window[name]) throw new Error(`unexpected global window.${name} likely leaked out of intended scope`)
    try {
      return _item(item.id).eval(`(typeof ${name} == 'function')`, {
        include_deps: false,
        trigger: 'itemDefinesFunction',
        ...options,
      })
    } catch (e) {
      return false
    }
  }

  let itemInitTime = 0
  function initItems() {
    if (itemInitTime) return // already initialized items
    itemInitTime = Date.now()
    items.forEach(item => {
      if (!item.init) return
      // if item has js_init block, use that, otherwise use js block (without dependencies to avoid complications due to init order etc)
      const init_block_type = extractBlock(item.text, 'js_init') ? 'js_init' : 'js'
      if (!itemDefinesFunction(item, '_init', { type: init_block_type })) return
      try {
        _item(item.id).eval('_init()', {
          type: init_block_type,
          include_deps: false,
          trigger: 'init',
        })
      } catch (e) {} // already logged, just continue init
    })
  }

  let initTime = 0 // set where initialize is invoked
  let instanceId // set after signin (depends on user id)
  let instance = !isClient
    ? null
    : {
        user: null, // set after signin (along w/ instanceId)
        init_time: 0, // set after init (together w/ initTime)
        update_time: 0, // set at each update
        focus_time: 0, // set whenever focus_time is set
        user_agent: navigator.userAgent,
        client_ip, // public ip
        server_ip, // server local ip
        server_name: server_name, // server local (host) name
        server_domain: location.host, // server public domain (a.k.a. host) name
        screen_size: { width: screen.width, height: screen.height },
        screen_avail: {
          left: screen['availLeft'],
          top: screen['availTop'],
          width: screen['availWidth'],
          height: screen['availHeight'],
        },
        screen_colors: { color_depth: screen.colorDepth, pixel_depth: screen.pixelDepth },
        hardware_concurrency: navigator.hardwareConcurrency,
        gpu: (() => {
          const gl = document.createElement('canvas').getContext('experimental-webgl') as any
          const gl_renderer_param = gl?.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL
          return gl_renderer_param ? gl.getParameter(gl_renderer_param) : 'unknown'
        })(),
      }
  let instances = [] // list of live instances, most recently focused first
  let primary = false // is this instance "primary", i.e. most recently focused live instance?
  let processed = false
  let initialized = false
  let maxRenderedAtInit = 100
  let specialTagFunctions = []
  let adminItems = new Set(['QbtH06q6y6GY4ONPzq8N' /* welcome item */])
  let hiddenItems
  let hiddenItemsByName
  let hiddenItemsInvalid
  let resolve_init // set below
  function init_log(...args) {
    console.debug(`[${Math.round(performance.now())}ms] ${args.join(' ')}`)
  }

  // function to initialize new item state to serve as central listing
  function initItemState(item, index, state = {}) {
    // state used in onEditorChange
    if (!item.attr) item.attr = null // default to null for older items missing attr
    // NOTE: editable and pushable are transient UX state unless saved in item.attr
    item.editable = (item.attr?.editable ?? true) || fixed // fixed items are always editable (but not deletable)
    item.pushable = (item.attr?.pushable ?? false) && !fixed // fixed items are not pushable
    item.shared = _.cloneDeep(item.attr?.shared) ?? null
    item.previewable = false // should be true iff previewText && previewText != text
    item.previewText = null
    item.expanded = null // macro expansion state initialized in expandMacros or during render toHTML in Item.svelte
    item.editing = false // otherwise undefined till rendered/bound to svelte object
    item.matching = false
    item.listing = false
    item.target = false
    item.target_context = false
    item.target_nesting = -Infinity
    item.target_prefix_nesting = -Infinity
    item.tagMatches = 0
    item.firstTagMatch = false
    item.labelMatch = false
    item.prefixMatch = false
    item.pinnedMatch = false
    item.pinnedMatchTerm = ''
    item.uniqueLabel = ''
    // item.uniqueLabelPrefixes = [];
    item.contextLabel = ''
    item.matchingTerms = []
    item.matchingTermsSecondary = []
    item.missingTags = []
    item.hasError = false
    // state from updateItemLayout
    item.index = index
    item.lastIndex = index
    item.aboveFold = false
    // item.prominence = 0;
    item.leader = false
    item.mover = false
    item.timeString = ''
    item.timeOutOfOrder = false
    item.height = 0
    item.rendered = false
    item.resolve_height = null // invoked from onItemResized on first resize during render
    item.resolve_render = null // invoked from onItemResized when rendering is complete
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

    // remove "admin" items (e.g. welcome item) on readonly account
    if (readonly) _.remove(items, item => adminItems.has(item.id))

    // filter "hidden" items used for encrypted synced storage
    // also move into hiddenItems map for easy access later
    // warn about hidden items on anonymous account
    const existing_ids = new Set<string>() // ids for global_store cleanup
    items.forEach(item => {
      if (!item.hidden) existing_ids.add(item.id)
    })
    hiddenItems = new Map()
    hiddenItemsByName = new Map()
    hiddenItemsInvalid = []
    // note we sort hidden items by id to resolve name conflicts by taking item w/ minimum id
    items
      .filter(item => item.hidden)
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach(item => {
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
      })
    items = items.filter(item => !item.hidden)

    // extract special tag functions
    for (const item of items) {
      if (!item.text.includes('_special_tag_aliases')) continue // quick check
      const js = extractBlock(item.text, 'js')
      if (!js) continue
      try {
        // note we need to use a function wrapper to avoid polluting global scope
        const f = eval.call(window, '(()=>{' + js + '; return _special_tag_aliases })()')
        if (typeof f !== 'function') throw new Error('invalid non-function _special_tag_aliases in item' + item.id)
        specialTagFunctions.push(f)
      } catch (e) {
        console.error(e)
      }
    }

    indexFromId = new Map<string, number>() // needed for initial itemTextChanged
    items.forEach((item, index) => indexFromId.set(item.id, (item.index = index)))
    items.forEach((item, index) => {
      itemTextChanged(index, item.text, false /*update_deps*/) // deps handled below after index assignment
      initItemState(item, index, {
        admin: adminItems.has(item.id),
        savedId: item.id,
        savedTime: item.time,
        savedAttr: _.cloneDeep(item.attr),
        savedText: item.text,
      })
    })
    finalizeStateOnEditorChange = true // make initial empty state final
    onEditorChange('') // initial sorting
    items.forEach((item, index) => {
      // initialize deps, deephash, missing tags/labels
      item.deps = itemDeps(index)
      item.deephash = hash(
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

    initItems() // invoke _init on items

    processed = true
    // init_log(`processed ${items.length} items`);

    // NOTE: last step in initialization is rendering, which is handled asynchronously by svelte and considered completed when onItemResized is invoked for each item (zero heights are logged as warning); we support initialization in chunks, but it seems background rendering can make rendered items unresponsive (even if done in small chunks with large intervals), so best option may be to have a hard truncation point to limit initialization time -- the downside of uninitialized items is that their heights are not known until they are rendered

    // in fixed mode, determine fixed ordering and hideIndex == maxRenderedAtInit before rendering
    if (fixed) {
      items = _.sortBy(items, item => item.attr.shared.indices?.[shared_key] ?? Infinity)
      maxRenderedAtInit =
        hideIndexMinimal =
        hideIndexFixed =
        hideIndex =
          _.sumBy(items, item => (item.shared.indices?.[shared_key] >= 0 ? 1 : 0))
    }
    const unpinnedIndex = _.findLastIndex(items, item => item.pinned) + 1
    await renderRange(
      0,
      unpinnedIndex || 10 /*initial chunk*/,
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
            else item.resolve_height = resolve // resolve later from onItemResized
          })
      )
    ).then(() => {
      if (!keepOnPageDuringDelay) renderStart = renderEnd
      if (renderEnd < cutoff) {
        // init_log(`rendered items ${renderStart}-${renderEnd}`)
        if (start == 0 || Math.floor(start / 100) < Math.floor(renderEnd / 100))
          init_log(`rendered ${renderEnd}/${items.length} items (limit ${cutoff})`)
        tick().then(() => setTimeout(() => renderRange(renderEnd, renderEnd + chunk, chunk, cutoff, delay), delay))
      } else {
        init_log(`rendered ${cutoff}/${items.length} items (limit ${cutoff})`)
        rendered = true
        // trigger a layout, even if onItemResized was never invoked
        // ensures scroll-to-header as needed to remove loading overlay
        updateItemLayout()
      }
    })
  }

  async function renderItem(item) {
    if (!(item instanceof _Item)) throw new Error('invalid item, must be of type _Item')
    if (!rendered) throw new Error('can not render specific item before initial rendering is complete')
    renderStart = item.index
    renderEnd = item.index + 1
    return tick().then(
      () =>
        new Promise(resolve => {
          const _item = __item(item.id)
          // set up resolve_render callback to be resolved from onItemResized
          // ensure any other pending render promises are also resolved
          const prev_resolve = _item.resolve_render
          _item.resolve_render = elem => {
            prev_resolve?.(elem)
            resolve(elem)
          }
          // if item container is available, we can invoke onItemResized immediately
          // note this will compute latest height and look for pending elements to see if render can be resolved
          const container = item.elem?.querySelector('.container')
          if (container) onItemResized(item.id, container, 'renderItem')
        })
    )
  }

  let updateInstance_task
  function updateInstance() {
    if (anonymous) return // can not track anonymous instances (at least not by user, and can not write to firestore)
    const task = () => {
      if (updateInstance_task != task) return // task cancelled or replaced
      if (!instanceId) return setTimeout(task, 1000) // instance id not set yet, try again in 1s
      if (instanceId != instance.user + '-' + instance.init_time) console.error('inconsistent instance id/info')
      if (instance.focus_time != focus_time) console.error('inconsistent instance info (focus_time)')
      instance.update_time = Date.now()
      setDoc(doc(getFirestore(firebase), 'instances', instanceId), instance)
        .catch(console.error)
        .finally(() => {
          setTimeout(task, 1000 * 60) // update again in ~60 (+setDoc time)
        })
    }
    updateInstance_task = task // cancels & replaces any previous task
    setTimeout(task) // initial dispatch
  }

  let signingIn = false
  function signIn() {
    // if user appears to be signed in, sign out instead
    if (getAuth(firebase).currentUser) {
      console.warn('attempted to sign in while already signed in, signing out ...')
      if (!signedin) _modal('inconsistent signin state! signing out ...').then(signOut)
      else signOut()
      return
    }
    signingIn = true

    // blur active element as caret can show through loading div
    // (can require dispatch on chrome if triggered from active element)
    setTimeout(() => (document.activeElement as HTMLElement).blur())

    resetUser()
    window.sessionStorage.setItem('mindpage_signin_pending', '1') // prevents anonymous user on reload
    document.cookie = '__session=signin_pending;max-age=600' // temporary setting for server post-redirect
    let provider = new GoogleAuthProvider()
    getAuth(firebase).useDeviceLanguage()
    setPersistence(getAuth(firebase), browserLocalPersistence).then(() => {
      // NOTE: Both redirect and popup-based login methods work in most cases. Android can fail to login with redirects (perhaps getRedirectResult could work better although should be redundant given onAuthStateChanged) but works ok with popup. iOS looks better with redirect, and firebase docs (https://firebase.google.com/docs/auth/web/google-signin) say redirect is preferred on mobile. Indeed popup feels better on desktop, even though it also requires a reload for now (much easier and cleaner than changing all user/item state). So we currently use popup login except on iOS, where we use a redirect for cleaner same-tab flow.
      // NOTE: switched to redirect on all platforms due to blocked popups on desktop
      // NOTE 2: switched back to popup (on non-ios) as redirect stopped working on Ventura Safari
      // NOTE 3: actually redirect also does not work on the iPad, so we are back to popup on all platforms
      //         (but it is annoying especially on mobile where popups can be blocked outright)
      // return signInWithRedirect(getAuth(firebase), provider).catch(console.error)
      // if (!android()) return signInWithRedirect(getAuth(firebase), provider).catch(console.error)
      // if (ios) return signInWithRedirect(getAuth(firebase), provider).catch(console.error)
      signInWithPopup(getAuth(firebase), provider)
        .then(() => location.reload())
        .catch(e => {
          console.error(e)
          _modal(
            e.code == 'auth/popup-blocked'
              ? `MindPage could not open a popup required to sign you in to your Google account. Please change your browser settings to allow popups and try again.`
              : `MindPage could not sign you in to your Google account.`,
            {
              confirm: 'Try Again',
              background: 'confirm',
              onConfirm: signIn,
            }
          )
        })
    })
  }

  function isAdmin() {
    return (
      user?.uid == 'y2swh7JY2ScO5soV7mJMHVltAOX2' && (location.host == 'mindbox.io' || url_params.user == 'anonymous')
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

      if (server_warning) console.warn(server_warning)
      if (server_error) {
        console.error(server_error)
        alert(server_error) // modal not available (undefined) at this point
        return // stop loading on server errors
      }

      // if sharer is known (on shared page, via shared=... param), fetch name immediately
      if (sharer)
        fetch('/user/' + sharer)
          .then(r => r.text())
          .then(name => {
            sharer_name = name
            sharer_short_name = sharer_name.match(/\S+/)?.pop()
          })

      // pre-fetch user from localStorage instead of waiting for onAuthStateChanged
      // (seems to be much faster to render user.photoURL, but watch out for possible 403 on user.photoURL)
      if (!user && localStorage.getItem('mindpage_user')) {
        user = JSON.parse(localStorage.getItem('mindpage_user'))
        secret = localStorage.getItem('mindpage_secret') // may be null if user was acting as anonymous
        init_log(`restored user ${user.email}`)
      } else if (window.sessionStorage.getItem('mindpage_signin_pending')) {
        init_log('resuming signin ...')
        window.sessionStorage.removeItem('mindpage_signin_pending') // no longer considered pending
        user = secret = null // user is to be determined at onAuthStateChanged
      } else {
        useAnonymousAccount()
      }
      admin = isAdmin()
      if (admin) useAnonymousAccount() // become anonymous for item checks below
      anonymous = user?.uid == 'anonymous'
      readonly = (anonymous && !admin) || (fixed && sharer != user?.uid)

      // print client load time w/ preloaded item count, excluding admin and hidden items
      const preload_count = _.sumBy(items_preload, ({ hidden, id }) =>
        !hidden && (!readonly || !adminItems.has(id)) ? 1 : 0
      )
      console.debug(
        `[${window['_client_start_time']}ms] loaded client` + (preload_count > 0 ? ` + ${preload_count} items` : '')
      )

      // if items were preloaded, confirm user and either ignore or init items
      if (items_preload.length > 0) {
        items = items_preload
        if (window.sessionStorage.getItem('mindpage_signin_pending')) {
          console.warn(`ignoring ${items.length} items during signin`)
          items = []
        } else if (user && user.uid != items[0].user && !(fixed && items[0].user == 'anonymous')) {
          // items are for wrong user, usually anonymous, due to missing (not expired) cookie
          // you can test this with document.cookie='__session=;max-age=0' in console
          // can also happen when admin is logged in but acting as anonymous
          // in fixed mode, this is fine as long as items are anonymous
          console.warn(`ignoring ${items.length} items for ${items[0].user}`)
          items = []
        } else {
          // NOTE: at this point item heights (and totalItemHeight) may be zero and loading overlay should be visible, but we need the items on the page to compute their heights, which will trigger updated layout through onItemResized
          initTime = window['_init_time'] = instance.init_time = Date.now() // init started
          initialize()
        }
      }

      // note this is experimental, to try to debug redirect auth failure in recent iOS and MacOS
      // getRedirectResult(getAuth(firebase))
      //   .then(result => {
      //     console.debug('getRedirectResult', result)
      //   })
      //   .catch(console.error)

      // start listening for auth changes & initialize firebase on first callback
      // NOTE: we expect a callback in all cases (e.g. even when user is signed out or anonymous)
      //       we use any additional callbacks to trigger an automatic reload ...
      let authStateReceived = false
      onAuthStateChanged(
        getAuth(firebase),
        authUser => {
          init_log('user:', authUser?.email || 'anonymous')

          // console.debug("onAuthStateChanged", user, authUser)
          if (signingIn || signingOut) return // ignore auth changes when signing in/out, which should trigger a reload

          // reload automatically if auth state is modified, e.g. due to signin/signout on another tab
          if (authStateReceived) {
            console.warn('auth state modified, reloading ...')
            location.reload()
            return
          }
          authStateReceived = true

          if (!authUser) {
            // if we were expecting signin, then we should let user know that we failed and offer to retry ...
            if (!anonymous) {
              _modal(`MindPage could not sign you in to your Google account.`, {
                confirm: 'Try Again',
                cancel: 'Cancel',
                onConfirm: signIn,
                onCancel: () => location.reload(),
              })
              return // cancel init (no need to indicate visually since reload is required)
            }
          } else {
            resetUser() // clean up first
            user = authUser
            const userInfoString = JSON.stringify(user) // uses custom user.toJSON (but does not assume it)
            localStorage.setItem('mindpage_user', userInfoString)
            anonymous = false // just in case (should already be false)
            // NOTE: we now allow readonly signin for 'fixed' mode
            signedin = true
            instance.user = user.uid
            // set sharer to self if not already set via shared=... param
            if (!sharer) {
              sharer = user.uid
              sharer_name = user.mindpageDisplayName || user.displayName
              sharer_short_name = sharer_name.match(/\S+/)?.pop()
            }
            readonly = (anonymous && !admin) || (fixed && sharer != user?.uid)

            // update user info (email, name, etc) in users collection
            const userInfo = Object.assign(JSON.parse(userInfoString), { lastUpdateAt: Date.now() })
            // firestore().collection('users').doc(user.uid).set(userInfo).catch(console.error)
            setDoc(doc(getFirestore(firebase), 'users', user.uid), userInfo).catch(console.error)

            // NOTE: olcans@gmail.com signed in as "admin" will ACT as anonymous account
            //       (this is the only case where user != getAuth(firebase).currentUser)
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
          }

          // note we initialize firebase even in anonymous mode, because (1) we can fallback to initial snapshot if items are not preloaded, and (2) we allow one-way sync of anonymous items from admin account
          initFirebaseRealtime()
        },
        console.error
      )

      // periodic macro expansion task ...
      const macroExpansionIdleTime = 250 // minimum idle time between scans/expansions
      const macroExpansionQuantum = 25 // time for macros in single quantum (before going idle)
      const slowMacroWarningThreshold = 250 // warn about macros taking longer than this
      let firstPassExpansionDone = false
      function expandMacros() {
        if (
          !initialized || // not initialized yet
          Date.now() - focus_time < 1000 || // interacted too recently
          Date.now() - lastScrollTime < 250 // scrolled too recently (even w/o triggering focus)
        )
          return setTimeout(expandMacros, macroExpansionIdleTime)
        const start = Date.now()
        let expansions = 0
        let errors = 0
        let index = 0
        for (const item of items) {
          index = item.index
          if (item.expanded?.error) continue // had errors in last expansion, need manual re-eval (render or read)

          // init or reset macro expansion state via item.read w/ eval_macros:true
          // note the reset conditions here (deephash, version, etc) should match those in toHTML in Item.svelte
          if (!item.expanded || item.expanded.deephash != item.deephash || item.expanded.version != item.version) {
            if (Date.now() - start > macroExpansionQuantum) break // out of time for another expansion
            try {
              const macro_start = Date.now()
              _item(item.id).read('', { eval_macros: true }) // sets item.expanded directly
              const macro_time = Date.now() - macro_start
              if (macro_time > slowMacroWarningThreshold)
                console.warn(`slow macros (${macro_time}ms) in item ${item.name}`)
            } catch (e) {} // errors already logged
            expansions++
          }
        }
        // if (expansions) {
        //   ;(firstPassExpansionDone ? console.debug : init_log)(
        //     `expanded macros in ${index + 1}/${items.length} items ` + `(+${expansions} in ${Date.now() - start}ms)`
        //   )
        // }
        const done = index == items.length - 1
        if (done && !firstPassExpansionDone) {
          firstPassExpansionDone = true
          init_log(`expanded macros in ${items.length} items`)
        }
        // indicate progress on .counts div in header
        const countsdiv = document.querySelector('.header .counts') as HTMLDivElement
        if (countsdiv) {
          const progress = Math.round(((index + 1) / items.length) * 100) + '%'
          countsdiv.style.background = done ? '#000' : `linear-gradient(90deg, #333 ${progress}, #111 ${progress})`
          countsdiv.style.opacity = done ? '1' : '.75'
        }
        setTimeout(expandMacros, macroExpansionIdleTime)
      }

      // visual viewport resize/scroll handlers ...
      let lastDocumentWidth = 0
      let lastWindowHeight = 0
      let lastFocusElem = null // element that had focus on last recorded width/height
      function checkLayout() {
        // set loader spinner size dynamically (since spinners otherwise require fixed pixel sizing)
        // spinnerSize = Math.max(60, Math.min(innerWidth, innerHeight) * 0.2)

        // on android, if window height grows enough, assume keyboard is closed and blur active element
        // (otherwise e.g. tapping of tags with editor focused will scroll back up)
        if (android && outerHeight > lastWindowHeight + 200) (document.activeElement as HTMLElement).blur()

        if (Date.now() - lastScrollTime < 250) return // avoid layout during scroll
        if (Date.now() - lastResizeTime < 250) return // avoid layout during resizing

        const isSameNode = (e1, e2) => e1 == e2 || (e1 && e2 && e1.isSameNode(e2))

        // update vertical padding, but only if we are consistently _unfocused_ (to avoid shifting during/after focus)
        // we also skip if page is being zoomed (scale != 1) to keep zooming as smooth as possible
        if (
          (!document.activeElement || isSameNode(document.activeElement, document.body)) &&
          isSameNode(document.activeElement, lastFocusElem) &&
          visualViewport.scale == 1
        )
          updateVerticalPadding()

        const documentWidth = getDocumentWidth()
        if (
          documentWidth != lastDocumentWidth ||
          // ignore height change if active element also changed
          // (to avoid responding to temporary virtual keyboards)
          (outerHeight != lastWindowHeight && isSameNode(document.activeElement, lastFocusElem))
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
        if (Date.now() - lastLayoutTime > 10000) {
          lastLayoutTime = Date.now()
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

        // listen for instances if user is not anonymous
        if (!anonymous) {
          onSnapshot(
            query(
              collection(getFirestore(firebase), 'instances'),
              where('user', '==', user.uid), // instances for user only
              where('update_time', '>', Date.now() - 2 * 60 * 1000), // live only (as of init)
              orderBy('update_time', 'desc') // required by index
            ),
            snapshot => {
              // note we always use the full snapshot, including local changes not yet synced to firebase
              instances = Array.from(snapshot.docs, (doc: any) => doc.data())
              instances = instances.filter(i => i.update_time > Date.now() - 2 * 60 * 1000) // filter dead since init
              instances = instances.sort((a, b) => b.focus_time - a.focus_time) // sort by decreasing focus time
              primary = instances[0]?.init_time == initTime
            }
          )
        }

        // determine query for shared items
        // note this fixed mode is different from server-side fixed mode, which shortcuts firebase sync above
        let items_query = query(
          collection(getFirestore(firebase), 'items'),
          where('user', '==', user.uid),
          orderBy('time', 'desc')
        )
        if (url_params.shared?.match(/^[\w-]+$/)) {
          const key = url_params.shared
          items_query = query(
            collection(getFirestore(firebase), 'items'),
            where('user', '==', user.uid),
            where('attr.shared.keys', 'array-contains', key)
          )
        } else if (url_params.shared?.match(/^\w+\/[\w-]+$/)) {
          const [owner, key] = url_params.shared.split('/')
          items_query = query(
            collection(getFirestore(firebase), 'items'),
            where('user', '==', owner),
            where('attr.shared.keys', 'array-contains', key)
          )
        } else if (url_params.shared) {
          _modal(`No items found on shared page \`${url_params.shared}\`.`)
          return
        }

        // start listening for remote changes
        // (also initialize if items were not returned by server)
        onSnapshot(
          items_query,
          snapshot => {
            // ignore (and warn about) snapshots disabled via _disable_sync
            if (window['_disable_sync']) {
              console.warn('ignoring firestore snapshot due to _disable_sync')
              return
            }
            // on first snapshot, if init has not started (!initTime), we simply populate items array and trigger initialization; otherwise we must be already initializing items received directly from server so we ignore the first snapshot (presumably coming from a local cache) and simply set up init completion logic
            if (firstSnapshot) {
              if (!initTime) {
                snapshot.docs.forEach(doc => items.push(Object.assign(doc.data(), { id: doc.id })))
                // alert on any firebase errors before/during first snapshot
                // note we refuse to initialize with errors to avoid potential corruption
                if (firebase_errors > 0) {
                  _modal(`MindPage could not access Google Cloud (Firestore).`, {
                    confirm: 'Try Again',
                    background: 'confirm',
                    onConfirm: () => location.reload(),
                  })
                } else {
                  initTime = window['_init_time'] = instance.init_time = Date.now() // init started
                  initialize()
                }
              }
              // set up callback to complete init (or "sync")
              Promise.resolve(initialization).then(() => {
                if (!initialized) {
                  // initialization failed, we should be signing out ...
                  if (!signingOut) _modal('initialization failed (w/o triggering signout)')
                  return
                }
                init_log(`synchronized ${items.length} items`)

                // if account is empty in fixed mode, stop & present modal to try again
                if ((items.length === 0 || hideIndex == 0) && fixed) {
                  _modal(`No items found on shared page \`${url_params.shared}\`.`)
                  return
                }

                // update instance info (user, init time, etc) in instances collection
                instanceId = user.uid + '-' + initTime
                updateInstance()

                // if account is empty, copy the welcome item from the anonymous account, which should also trigger a request for the secret phrase in order to encrypt the new welcome item
                if (items.length == 0) {
                  onEditorDone('/_welcome')
                  hideIndex = 1 // show first item
                }

                // if necessary, init secret by triggering a test encryption/decryption
                if (!secret && !fixed) {
                  const hello_item = { user: user.uid, time: Date.now(), text: 'hello' }
                  encryptItem(hello_item)
                    .then(decryptItem)
                    .then(item => {
                      if (JSON.stringify(item) != JSON.stringify(hello_item)) throw new Error('encryption test failed')
                    })
                    .catch(encryptionError)
                }

                // delete invalid hidden items after initialization
                hiddenItemsInvalid.forEach(wrapper => {
                  console.warn('deleting invalid hidden item', wrapper.name, wrapper.id, wrapper)
                  deleteHiddenItem(wrapper.id)
                })

                // if narrating, fill .webcam-title from #webcam-title item if it exists
                if (narrating)
                  document.querySelector('.webcam-title').innerHTML = _item('#webcam-title')?.read('html') ?? ''
              })

              firstSnapshot = false
              return // done with first snapshot
            }

            // handle changes in non-first snapshot, waiting for init if necessary
            Promise.resolve(initialization).then(() => {
              if (!initialized) {
                // initialization failed, we should be signing out ...
                if (!signingOut) _modal('initialization failed (w/o triggering signout)')
                return
              }
              snapshot.docChanges().forEach(function (change) {
                const doc = change.doc
                if (doc.metadata.hasPendingWrites) return // ignore local changes
                decryptItem(doc.data()).then(savedItem => {
                  // remote changes indicate non-focus: update sessionTime and invoke onFocus
                  sessionTime = Date.now() + 1000 /* margin for small time differences */
                  onFocus() // focused = document.hasFocus()

                  // console.debug("detected remote change:", change.type, doc.id);
                  if (change.type === 'added') {
                    if (savedItem.hidden) {
                      const wrapper = Object.assign(JSON.parse(savedItem.text), { id: doc.id })
                      if (hiddenItemsByName.has(wrapper.name))
                        console.warn(
                          'remote-added hidden item exists locally; conflicts are resolved arbitrarily based on firebase id order'
                        )
                      hiddenItems.set(wrapper.id, wrapper)
                      if (!(hiddenItemsByName.get(wrapper.name)?.id < wrapper.id))
                        hiddenItemsByName.set(wrapper.name, wrapper) // points to minimum-id wrapper w/ this name
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
                    // update mutable ux properties from item.attr
                    item.editable = (item.attr?.editable ?? true) || fixed
                    item.pushable = (item.attr?.pushable ?? false) && !fixed
                    item.shared = _.cloneDeep(item.attr?.shared) ?? null
                    items = [item, ...items]
                    // update indices as needed by itemTextChanged
                    items.forEach((item, index) => indexFromId.set(item.id, (item.index = index)))
                    itemTextChanged(
                      0,
                      item.text,
                      true /* update_deps */,
                      false /* run_deps */,
                      false /* keep_time */,
                      true /* remote */
                    )
                    // console.debug('adding item', item.name)
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
                      // switch to any other hidden item w/ same name & with minimal id
                      for (const dup of hiddenItems.values()) {
                        if (dup.name == wrapper.name && !(hiddenItemsByName.get(dup.name)?.id < dup.id))
                          hiddenItemsByName.set(dup.name, dup)
                      }
                      hiddenItemChangedRemotely(wrapper.name, change.type)
                      return
                    }
                    // NOTE: remote remove is similar to deleteItem
                    // NOTE: document may be under temporary id if it was added locally
                    let index = indexFromId.get(tempIdFromSavedId.get(doc.id) ?? doc.id)
                    if (index === undefined) return // nothing to remove
                    let item = items[index]
                    // console.debug('removing item', item.name)
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
                    items.forEach((item, index) => indexFromId.set(item.id, (item.index = index)))
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
                          `remote-modified hidden item has new name ${wrapper.name}; older name ${
                            hiddenItems.get(wrapper.id).name
                          } will still work locally until reload`
                        )
                      hiddenItems.set(wrapper.id, wrapper)
                      if (!(hiddenItemsByName.get(wrapper.name)?.id < wrapper.id))
                        hiddenItemsByName.set(wrapper.name, wrapper) // points to minimum-id wrapper w/ this name
                      hiddenItemChangedRemotely(wrapper.name, change.type)
                      return
                    }
                    // NOTE: remote modify is similar to _write without saving
                    // NOTE: document may be under temporary id if it was added locally
                    let index = indexFromId.get(tempIdFromSavedId.get(doc.id) ?? doc.id)
                    if (index === undefined) return // nothing to modify
                    let item = items[index]
                    item.time = item.savedTime = savedItem.time
                    item.text = item.savedText = savedItem.text
                    const attr_modified = !_.isEqual(item.attr, savedItem.attr)
                    item.attr = savedItem.attr
                    item.savedAttr = _.cloneDeep(savedItem.attr)
                    // update mutable ux properties from item.attr
                    item.editable = (item.attr?.editable ?? true) || fixed
                    item.pushable = (item.attr?.pushable ?? false) && !fixed
                    item.shared = _.cloneDeep(item.attr?.shared) ?? null
                    // if attr is modified, invoke _on_attr_change on item or listeners
                    // note it is important to do this after updating dependent properties like item.shared
                    if (attr_modified) itemAttrChanged(item.id, true /* remote */)
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
                    // reset preview hash to prevent warning when previews are synced across tabs
                    delete item.local_store?._preview_hash
                  }
                })
              }) // snapshot.docChanges().forEach
            }) // Promise.resolve(initialization).then
          },
          error => {
            console.error(error)
            if (error.code == 'permission-denied') {
              // NOTE: server (admin) can still preload items if user account was deactivated with encrypted items
              //       (this triggers a prompt for secret phrase on reload, but can be prevented by clearing cookie)
              // NOTE: as of 3/1/2022, all users are allowed, except those in blocked_users collection
              //       (so any emails should be investigated as a request to be unblocked)
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
              if (prefix) prefix = '[' + prefix + ']'
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
              elem.textContent = (prefix + ' ' + text).trim()
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
              summarydiv.title =
                `${summarydiv.childElementCount} message` + (summarydiv.childElementCount == 1 ? '' : 's')

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
        setTimeout(expandMacros, 250) // expand macros every 250ms (+ macro time)
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

        // display signin modal on readonly non-fixed accounts, unless the url was for a specific item
        let welcome = null
        if (readonly && !fixed && !location.hash) {
          welcome = modal.show({
            content:
              '**Welcome to MindPage!** This is an _anonymous demo account_. Your edits will be discarded when you close or reload this page, and are _never sent or stored anywhere_.',
            // content: `Welcome ${window["_user"].name}! Your personal account requires activation. Please email support@mind.page from ${user.email} and include account identifier \`${user.uid}\` in the email.`,
            confirm: 'Stay Anonymous',
            cancel: 'Sign In',
            onCancel: signIn,
            background: 'confirm',
          })
        }
        // display welcome modal for viewing shared (fixed) items
        // note this is done pre-init so e.g. number of items is unknown at this point
        if (fixed) {
          _modal(
            `**Welcome to MindPage!** This is a _shared page_ with limited functionality. Your edits will be discarded when you close or reload this page, and are _never sent or stored anywhere_.`,
            {
              confirm: 'View Shared Page',
              // cancel: 'Go to My Page',
              // onCancel: () => (location.href = 'https://' + location.host),
              // background: 'confirm',
              passthrough: true,
            }
          )
        }

        // once initialization is done, welcome dialog is dismissed, dom is fully updated ...
        Promise.all([initialization, welcome])
          .then(update_dom)
          .then(() => {
            // on localhost, start watching local repo paths for installed items
            if (hostname == 'localhost') {
              ;(async () => {
                for (const item of items) if (item.attr?.repo) await watchLocalRepo(item.attr?.repo)
              })()
            }

            // if url fragment ("hash") corresponds to an item tag or id, focus on that item ...
            if (url_hash) {
              // if it is a valid item id, then we convert it to name
              // this means tags that match item ids can not be linked to, which seems fine
              const index = indexFromId.get(url_hash.substring(1))
              let unique = false
              if (index !== undefined) {
                unique = true
                replaceStateOnEditorChange = true // replace state
                lastEditorChangeTime = 0 // disable debounce even if editor focused
                onEditorChange(items[index].name)
              } else if (idsFromLabel.get(url_hash.toLowerCase())?.length) {
                unique = idsFromLabel.get(url_hash.toLowerCase())?.length == 1
                replaceStateOnEditorChange = true // replace state
                lastEditorChangeTime = 0 // disable debounce even if editor focused
                onEditorChange(url_hash)
              } else {
                _modal(`url fragment ${url_hash} does not match any items`)
              }
              // if hash matches a unique item, scroll to that item if needed
              if (unique) update_dom().then(scrollToTarget)
            }

            // finalize dom & evaluate _on_welcome on welcome items
            update_dom().then(() => {
              items.forEach(item => {
                if (!item.welcome) return
                if (!itemDefinesFunction(item, '_on_welcome')) return
                Promise.resolve(
                  _item(item.id).eval('_on_welcome()', {
                    trigger: 'welcome',
                    async: item.deepasync, // run async if item is async or has async deps
                    async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
                  })
                ).catch(e => {}) // already logged
              })
            })
          })

        init_log('initialized document')
      })

      init_log(`initialized client`)
    })

  function onColumnPaddingMouseDown(e) {
    e.preventDefault() // prevent click & focus shift
    scrollTo(headerdiv.offsetTop)
  }

  function onHistoryItemMouseDown(e, index) {
    e.preventDefault() // prevent click & focus shift
    e.stopPropagation()
    // if index is current state, history.go would reload so we just scroll to top
    if (index == sessionStateHistoryIndex) {
      scrollTo(headerdiv.offsetTop)
      return
    } else {
      scrollToTopOnPopState = true
      history.go(index - sessionStateHistoryIndex)
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!e.metaKey) focus() // focus on keydown, except when cmd-modified, e.g. for cmd-tilde
    const key = e.code || e.key // for android compatibility
    if (!key) return // can be empty for pencil input on ios
    // console.debug("window.onKeyDown:", e, key)

    const modified = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey

    // console.debug(e, initialized, modal.visible());
    if (!initialized) return
    if (modal.visible()) return // ignore keys when modal is visible

    // ignore keys (except forward to _on_key) in fixed mode
    if (fixed) {
      if (window['_on_key']) window['_on_key'](key, e)
      return
    }

    // end intro mode (while narrating) on non-modified keydown
    // if (intro && !modified) document.querySelector('.webcam-background.intro')?.dispatchEvent(new MouseEvent('click'))

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
        if (toggleTop > document.body.scrollTop + visualViewport.height - 200)
          scrollTo(Math.max(headerdiv.offsetTop, toggleTop - visualViewport.height / 4))
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
        if (target) scrollTo(Math.max(headerdiv.offsetTop, target.offsetTop - visualViewport.height / 4))
        else scrollTo(headerdiv.offsetTop) // just scroll to top
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
          _modal(`item numbered ${index + 1} (${item.name}) is not visible`)
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
      if (target && target.getAttribute('data-item-id') != lastEditItem) {
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
    // let unmodified ArrowLeft/Right select prev/next visible non-label tag in last context item
    if ((key == 'ArrowLeft' || key == 'ArrowRight') && !modified) {
      // pick "most recently interacted context that contains selected tag"; this is usually the parent context immediately above target but does not have to be, and this approach keeps the prev/next navigation context stable while still allowing additional context to appear below/above and also allowing switching navigation context by interacting with those other context items if desired
      let lastContext = Array.from(document.querySelectorAll('.container.target_context'))
        .filter(e => e.querySelector('mark.selected'))
        .sort((a, b) => item(b.getAttribute('data-item-id')).time - item(a.getAttribute('data-item-id')).time)[0]

      // if no context/target but query is a tag, then take it as target and its parent as context
      // note this allows keyboard navigation to children w/ non-unique labels
      if (!lastContext && editorText.trim().match(/^#[^#\s]+$/)) {
        const targetLabel = editorText.trim()
        const parentLabel = targetLabel.replace(/\/[^\/]*$/, '')
        if (parentLabel != targetLabel && _exists(parentLabel, false /* allow_multiple */)) {
          lastContext = _item(parentLabel).elem?.querySelector('.container')
          if (!lastContext?.querySelector('mark.selected')) lastContext = null
        }
      }
      if (lastContext) {
        let visibleTags = Array.from(lastContext.querySelectorAll('mark:not(.hidden,.label,.deps-and-dependents *)'))
        // drop duplicates to avoid ambiguities/cycles
        visibleTags = _.uniqBy(visibleTags, (t: any) => t.title)
        // drop non-parsed tags that are dynamically generated via macros, html/dom manipulation, etc
        const parsedVisibleTags = item(lastContext.getAttribute('data-item-id')).tagsVisible
        visibleTags = visibleTags.filter((t: any) => parsedVisibleTags.includes(t.title.toLowerCase()))
        let selectedIndex = visibleTags?.findIndex(e => e.matches('.selected'))
        // if context is based on nesting (vs _context tag) and selected tag is nested under it, then we only navigate among other nested siblings, thus giving preference to nested context navigation over unstructured context navigation which can be much more confusing
        const contextLabel = (lastContext.querySelector('mark.label') as any)?.title
        // context labels can be non-unique, so we have to use item(lastContext.getAttribute("data-item-id"))
        const contextBasedOnNesting = contextLabel && !item(lastContext.getAttribute('data-item-id')).context
        if (
          selectedIndex >= 0 &&
          contextBasedOnNesting &&
          visibleTags[selectedIndex]['title']?.startsWith(contextLabel + '/')
        ) {
          visibleTags = visibleTags.filter(t => t['title']?.startsWith(contextLabel + '/')) // siblings
          selectedIndex = visibleTags.findIndex(e => e.matches('.selected'))
        }
        if (selectedIndex >= 0) {
          if (key == 'ArrowRight' && selectedIndex < visibleTags.length - 1) {
            visibleTags[selectedIndex + 1].dispatchEvent(new MouseEvent('mousedown', { altKey: true }))
            return
          } else if (key == 'ArrowLeft' && selectedIndex > 0) {
            visibleTags[selectedIndex - 1].dispatchEvent(new MouseEvent('mousedown', { altKey: true }))
            return
          }
        }
      }
    }
    // let unmodified ArrowDown select first visible non-label non-secondary-selected "child" tag in target item; we avoid secondary-selected context tags since we are trying to navigate "down"
    if (key == 'ArrowDown' && !modified) {
      let targetLabel = (document.querySelector('.container.target mark.label') as any)?.title
      if (!_exists(targetLabel, false /* allow_multiple */)) targetLabel = null // avoid id-matching or multiple targets
      let nextTargetId
      if (targetLabel) {
        // we require nested children unless target is marked _context, because otherwise going "down" into non-nested children gets confusing since the target would not appear as context; note however target may not be treated as context if there are multiple nested children with the same label
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
          return
        } else {
          // if no child found on target, search for items w/ nested names
          const childLabel = _labels(
            (label, ids) =>
              ids.length == 1 && label.startsWith(targetLabel + '/') && label.indexOf('/', targetLabel.length + 1) == -1
          )[0]
          if (childLabel) {
            lastEditorChangeTime = 0 // force immediate update
            forceNewStateOnEditorChange = true // add to history like click-based nav
            onEditorChange(childLabel, true /* keep_times */) // keep_times for consistency w/ mousedown w/ altKey:true
            // note since we are using onEditorChange, we need to handle scrolling as needed
            update_dom().then(scrollToTarget)
            return
          }

          // if still no child found, search for "next" non-pinned item w/ unique label; "next" means that the label is not in editorChangesWithTimeKept, which contains all recent arrow-based (or alt-held) navigation that is considered less intentional and should not modify item times
          // const targetIndex = item(_item(targetLabel).id).index
          // nextTargetId = items.find(
          //   item =>
          //     item.index > targetIndex && !item.pinned && item.labelUnique && !editorChangesWithTimeKept.has(item.label)
          // )?.id
        }
      } else if (!editorText.trim()) {
        // if there is no active query, select first non-pinned item w/ unique label (if visible on page)
        nextTargetId = items.find(item => !item.pinned && item.labelUnique)?.id
      }
      if (nextTargetId) {
        let nextTarget = document.querySelector(`#super-container-${nextTargetId} mark.label`)
        if (nextTarget) {
          nextTarget.dispatchEvent(new MouseEvent('mousedown', { altKey: true }))
          return
        }
      }
      // attempt to click on a show toggle & scroll down if needed
      const showToggle = document.querySelector(`.toggle.show`)
      if (showToggle) {
        // if toggle is too far down, bring it to ~upper-middle of page, snapping to header
        // alternatively, we could toggle only if already visible, to avoid forcing a scroll too far down page
        const toggleTop = (showToggle as HTMLElement).offsetTop
        if (toggleTop < document.body.scrollTop + visualViewport.height) showToggle.dispatchEvent(new Event('click'))
        // if (toggleTop > document.body.scrollTop + visualViewport.height - 200)
        //   scrollTo(Math.max(headerdiv.offsetTop, toggleTop - visualViewport.height / 4))
        // showToggle.dispatchEvent(new Event('click'))
        return
      }
    }
    // let unmodified or alt-modified ArrowUp select label on last context item (i.e. move up to parent)
    if (key == 'ArrowUp' && (!modified || e.altKey)) {
      // first attempt to click on top-most hide toggle, if any
      const hideToggle = document.querySelector(`.toggle.hide`)
      if (hideToggle) {
        hideToggle.dispatchEvent(new Event('click'))
        return
      }
      // see comments above about lastContext
      let lastContext = Array.from(document.querySelectorAll('.container.target_context'))
        .filter(e => e.querySelector('mark.selected'))
        .sort((a, b) => item(b.getAttribute('data-item-id')).time - item(a.getAttribute('data-item-id')).time)[0]
      if (!lastContext && editorText.trim().match(/^#[^#\s]+$/)) {
        const targetLabel = editorText.trim()
        const parentLabel = targetLabel.replace(/\/[^\/]*$/, '')
        if (parentLabel != targetLabel && _exists(parentLabel, false /* allow_multiple */)) {
          lastContext = _item(parentLabel).elem?.querySelector('.container')
          // if (!lastContext?.querySelector('mark.selected')) lastContext = null
        }
      }
      if (lastContext) {
        lastContext.querySelector('mark.label')?.dispatchEvent(new MouseEvent('mousedown', { altKey: true }))
        // also click on any hide toggle (which must be below new target)
        update_dom().then(() => {
          document.querySelector(`.toggle.hide`)?.dispatchEvent(new Event('click'))
        })
        return
      }
    }

    // unedit last edited item (if any) on unmodified escape or unhandled backspace/arrowup
    // if no edited items left, then clear editor (mindbox)
    if ((key == 'Escape' || key == 'Backspace' || key == 'ArrowUp') && !modified) {
      e.preventDefault()
      if (editingItems.length) {
        // unedit the last edited item
        const index = _.last(editingItems)
        onItemEditing(index, (items[index].editing = false), true /* cancelled */, false /* run */, e)
        return
      } else if (editorText) {
        hideIndex = hideIndexMinimal
        // this follows onTagClick behavior
        editorText = ''
        forceNewStateOnEditorChange = true // force new state
        // finalizeStateOnEditorChange = true; // finalize state
        lastEditorChangeTime = 0 // disable debounce even if editor focused
        onEditorChange(editorText)
        return
      }
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
      key == 'ArrowUp' /*&& e.metaKey*/ ||
      (key == 'ArrowDown' && e.metaKey) ||
      key == 'Backspace' ||
      key == 'Tab' ||
      key == 'Escape'
    ) {
      e.preventDefault()
      hideIndex = hideIndexMinimal
      // scroll up to header if necessary
      if (document.body.scrollTop > headerdiv.offsetTop) scrollTo(headerdiv.offsetTop)
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

  function onFocused() {
    // invoke _on_focus() on all listener items
    items.forEach(item => {
      if (!item.listen) return // must be listener
      if (!itemDefinesFunction(item, '_on_focus')) return
      Promise.resolve(
        _item(item.id).eval(`_on_focus()`, {
          trigger: 'listen',
          async: item.deepasync, // run async if item is async or has async deps
          async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
        })
      ).catch(e => {}) // already logged
    })

    // update instance immediately (vs wait up to 60s) on focus
    // allows background instances to react to focus events across all instances
    updateInstance()
  }

  function onFocus() {
    // NOTE: on ios (also android presumably), windows do not defocus when switching among split-screen windows
    if (ios || android) return // focus handled in focus/checkFocus below
    const was_focused = focused
    focused = document.hasFocus()
    // note focus_time tracks interactions beyond focused=true
    if (focused) focus_time = instance.focus_time = Date.now()
    if (focused && !was_focused) onFocused() // handle change to focused=true
    // retreat to minimal hide index when window is defocused
    // if (was_focused && !focused) hideIndex = hideIndexMinimal;
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
    focus_time = instance.focus_time = Date.now() // note focus_time tracks interactions beyond focused=true
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
    onFocused() // handle change to focused=true
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
            updateDoc(doc(getFirestore(firebase), 'items', saved_id), itemToSave)
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
            addDoc(collection(getFirestore(firebase), 'items'), itemToSave)
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
      // switch to any other hidden item w/ same name & with minimal id
      for (const dup of hiddenItems.values()) {
        if (dup.name == wrapper.name && !(hiddenItemsByName.get(dup.name)?.id < dup.id))
          hiddenItemsByName.set(dup.name, dup)
      }
    }
    if (readonly) return // no saving
    // console.debug("deleting hidden item", name);
    // NOTE: if item is saving, we need to wait for its persistent id before we can delete
    Promise.resolve(wrapper?.saving || id).then(saved_id => {
      deleteDoc(doc(getFirestore(firebase), 'items', saved_id))
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
      let id = name.replace(/^global_store_/, '')
      // warn if owner <id> (always saved_id for global_store) is missing locally
      // note owner item (not the hidden item itself) can be under temp id locally
      // also item should exist before its global_store does
      id = tempIdFromSavedId.get(id) ?? id
      if (!_exists(id)) {
        console.warn(`missing local item for remote-${change_type} hidden item ${name}`)
        return
      }
      // console.debug("hiddenItemChangedRemotely", name, change_type, hiddenItemsByName.get(name)?.item);
      item(id).global_store = _.cloneDeep(hiddenItemsByName.get(name)?.item) || {} // sync global_store on item

      // invoke _on_global_store_change(id, true) on all listener (or self) items
      // NOTE: "deletions" of hidden item correspond to a change to empty store {}
      items.forEach(item => {
        if (!item.listen && item.id != id) return // must be listener or self
        if (!itemDefinesFunction(item, '_on_global_store_change')) return
        Promise.resolve(
          _item(item.id).eval(`_on_global_store_change('${id}',true)`, {
            trigger: item.listen ? 'listen' : 'change',
            async: item.deepasync, // run async if item is async or has async deps
            async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
          })
        ).catch(e => {}) // already logged
      })

      // invalidate element cache and force re-render
      _item(id).invalidate_elem_cache({ force_render: true })
      return
    }
  }

  function itemAttrChanged(id, remote) {
    // invoke _on_attr_change(id, remote) on all listener (or self) items
    items.forEach(item => {
      if (!item.listen && item.id != item.id) return // must be listener or self
      if (!itemDefinesFunction(item, '_on_attr_change')) return
      Promise.resolve(
        _item(item.id).eval(`_on_attr_change('${item.id}', ${remote})`, {
          trigger: item.listen ? 'listen' : 'change',
          async: item.deepasync, // run async if item is async or has async deps
          async_simple: true, // use simple wrapper (e.g. no output/logging into item) if async
        })
      ).catch(e => {}) // already logged
    })
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
    // if spinner is active (condition mirrors svelte {#if ...} block below), show error using alert
    if (!user || !initialized || !headerScrolled || renderingVisibleItems || signingIn || signingOut) _modal(msg)
  }
  // wrap fetch to throw exceptions on HTTP errors, since they (unlike XMLHTTPRequest) do not throw exceptions or even log to console using console.error (since they also do not show up in mindpage console)
  if (isClient) {
    const _fetch = window.fetch
    window.fetch = async function (...args) {
      const resp = await _fetch(...args)
      if (!resp.ok) {
        let body = '(no body)'
        try {
          body = await resp.text()
        } catch {}
        // note we attach resp and body to thrown error
        throw _.assign(new Error(`fetch failed: ${resp.status} (${resp.statusText}); ` + body), { resp, body })
      }
      return resp
    }
  }
  // set up firebase log handler to count firebase errors (client only)
  let firebase_errors = 0
  if (isClient)
    firebase.onLog(({ level }) => {
      if (level == 'error') firebase_errors++
    })

  // replace window.{alert,confirm,prompt} to warn that they may stop working on iOS devices
  // known bug since 2016, see e.g. https://stackoverflow.com/questions/38083702/alert-confirm-and-prompt-not-working-after-using-history-api-on-safari-ios
  if (isClient) {
    const replace_dialog = method => {
      const _dialog = window[method] as any
      window[method] = function (...args) {
        console.warn(`window.${method} can stop working on iOS devices; consider using _modal_${method} instead`)
        return _dialog(...args)
      } as any
    }
    ;['alert', 'confirm', 'prompt'].forEach(replace_dialog)
  }

  // convenient _modal-based async replacement for window.alert
  // note we do not display the 'OK' button and instead allow clicking on background
  function _modal_alert(msg, done = null) {
    return _modal(msg).then(() => done?.())
  }

  // convenient _modal-based async replacement for window.confirm
  function _modal_confirm(msg, confirmed = null, cancelled = null) {
    return _modal(msg, { confirm: 'OK', cancel: 'Cancel' }).then(ok => {
      if (ok) confirmed?.()
      else cancelled?.()
      return ok
    })
  }

  // convenient _modal-based async replacement for window.prompt
  function _modal_prompt(msg, default_text = '', confirmed = null, cancelled = null) {
    return _modal(msg, { confirm: 'OK', cancel: 'Cancel', input: default_text }).then(text => {
      if (text !== null) confirmed?.(text)
      else cancelled?.()
      return text
    })
  }

  function onWebcamClick(e) {
    intro = !intro
    // replace state except for first (always intro)
    if (history.state.index > 0) replaceState(Object.assign(history.state, { intro }))
    e.stopPropagation()
    ;(e.target as HTMLElement).classList.toggle('intro')
  }

  // retrieve host name, via globalThis.request on server side (see server.ts)
  const hostname =
    typeof location == 'undefined'
      ? globalThis.hostname
      : location.hostname.replace(/^(?:127\.0\.0\.1|local\.dev|192\.168\.86\.10\d)$/, 'localhost')

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
                  showButtons={true}
                  cancelOnDelete={true}
                  createOnAnyModifiers={true}
                  clearOnShiftBackspace={true}
                  allowCommandCtrlBracket={true}
                  propagateArrowUpDownAtEdges={true}
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
                  referrerpolicy="no-referrer"
                  on:click|stopPropagation={() => (!signedin ? signIn() : signOut())}
                />
              {/if}
            </div>
            <div class="status" class:hasDots={dotCount > 0} on:click={onStatusClick}>
              {#if fixed && items.length > 0}
                <div class="left">
                  {#if items[0].shared.indices?.[shared_key] != 0}
                    <span class="triangle" on:click={() => window['MindBox'].clear()}>◀</span>
                  {/if}
                  <span title={(items[0].labelText ?? '').replace(/^#/, '')}>
                    {(items[0].labelText ?? '').replace(/^#/, '')}
                  </span>
                </div>
                <div
                  class="center"
                  title={(items[0].title || shared_key) + (sharer_short_name ? ', shared by ' + sharer_short_name : '')}
                >
                  <div class="title">{items[0].title || shared_key}</div>
                  {#if sharer_short_name}
                    <div class="subtitle">shared by <span class="sharer-name">{sharer_short_name || ''}</span></div>
                  {/if}
                </div>
              {/if}
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
              {#if !fixed && items.length > 0}
                <div class="counts">
                  {#if matchingItemCount > 0}
                    &nbsp;<span class="matching"
                      >{matchingItemCount} matching item{matchingItemCount > 1 ? 's' : ''}</span
                    >
                  {:else}
                    {items.length} item{items.length > 1 ? 's' : ''}
                  {/if}
                </div>
              {/if}
              <div class="console" bind:this={consolediv} on:click={onConsoleClick} />
            </div>
            <div class="history">
              <div class="history-container">
                {#each sessionStateHistory as state, index}
                  {#if index < sessionStateHistory.length - 1 && state.editorText?.trim()}
                    <div
                      class="history-item"
                      class:current={index == sessionStateHistoryIndex}
                      on:mousedown={e => onHistoryItemMouseDown(e, index)}
                    >
                      {state.editorText?.trim() || '(clear)'}
                    </div>
                  {/if}
                {/each}
              </div>
            </div>
          </div>
        {/if}

        {#each items as item (item.id)}
          {#if item.column == column || (item.index >= hideIndex && column == columnCount)}
            {#if column < columnCount}
              {#if item.index == hideIndex}
                {#each toggles as toggle}
                  {#if toggle.start == hideIndex}
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
                onPreview={onItemPreview}
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
                {onMacrosExpanded}
                expanded={item.expanded}
                bind:text={item.text}
                bind:editing={item.editing}
                bind:focused={item.focused}
                editable={item.editable}
                pushable={item.pushable}
                previewable={item.previewable}
                saving={item.saving}
                running={item.running}
                admin={item.admin}
                {fixed}
                source={item.attr ? item.attr.source : ''}
                path={item.attr ? item.attr.path : ''}
                hidden={item.index >= hideIndex || (item.dotted && !showDotted)}
                showLogs={item.showLogs}
                height={item.height}
                time={item.time}
                index={item.index}
                id={item.id}
                name={item.name}
                label={item.label}
                labelText={item.labelText}
                labelUnique={item.labelUnique}
                hash={item.hash}
                deephash={item.deephash}
                bind:version={item.version}
                contextLabel={item.contextLabel}
                missingTags={item.missingTags.join(' ')}
                matchingTerms={item.matchingTerms.join(' ')}
                matchingTermsSecondary={item.matchingTermsSecondary.join(' ')}
                matching={item.matching}
                target={item.target}
                target_context={item.target_context}
                timeString={item.timeString}
                timeOutOfOrder={item.timeOutOfOrder}
                depsString={item.depsString}
                dependentsString={item.dependentsString}
                aboveFold={item.aboveFold}
                leader={item.leader}
                runnable={item.runnable}
              />
              {#if item.nextColumn >= 0 && item.index < hideIndex && (!fixed || item.index < hideIndexFixed - 1)}
                <div class="section-separator">
                  <hr />
                  <span class="arrows">{item.arrows}</span>{item.index + 2}
                  {#if item.nextItemInColumn >= 0 && item.nextItemInColumn <= hideIndex}
                    &nbsp; &nbsp; &nbsp;
                    <span class="arrows">↓</span>{item.nextItemInColumn + 1}
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

<div
  class="loading"
  class:translucent={renderingVisibleItems}
  class:visible={!user || !initialized || !headerScrolled || renderingVisibleItems || signingIn || signingOut}
>
  <Jumper size="20" unit="vw" color="#48f" duration="1.2s" />
</div>

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
  on:beforeunload={onBeforeUnload}
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

{#if fixed}
  <style>
    .column-padding,
    .header .editor,
    .header .history,
    .header .status .counts,
    .super-container > .time {
      display: none !important;
    }
    .header .header-container {
      justify-content: center;
      background: transparent !important;
      border: none !important;
      padding: 0 !important;
    }
    .header .header-container .user {
      position: absolute;
      top: 0;
      right: 0;
      margin: 0;
      margin-right: -1px; /* hit right edge of page */
      height: 40px;
      width: 40px;
      min-width: 28px;
      border-radius: 0;
      border-bottom-left-radius: 5px;
      z-index: 1;
    }
    .column.multi-column .header .header-container .user {
      right: 1px; /* align w/ item container edge below, see "margin-right: 1px" above */
      border-bottom-right-radius: 5px; /* round out right side also */
    }
    .header .status {
      position: static !important; /* position absolute children relative to .header instead */
      display: flex; /* allow flexible sizing of lable, title, etc */
      justify-content: right; /* in case .left/.center are hidden due to no items */
      margin-right: 48px !important; /* clear .user */
      padding: 0 !important;
      height: 44px !important; /* .user + 4px margin below */
      margin-bottom: -4px !important; /* eat into top padding of first item's .super-container */
      /* to allow selection in .counts, we are forced to undo styles on parent, then redo on console-summary */
      -webkit-touch-callout: auto !important;
      -webkit-user-select: auto !important;
      user-select: auto !important;
      cursor: auto !important;
    }
    .header .status :is(.left, .center) {
      box-sizing: border-box;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: left;
      font-family: 'Open Sans', sans-serif;
      font-weight: 600;
      font-size: 15px;
    }
    .header .status .left {
      flex-grow: 1;
      max-width: fit-content;
      height: fit-content;
      color: black;
      background: #aaa;
      padding: 8px;
      border-bottom-right-radius: 5px;
      font-size: 16px;
    }
    .column.multi-column .header .status .left {
      margin-left: 1px; /* align w/ item container edge below, see "margin-right: 1px" above */
      border-bottom-left-radius: 5px; /* round out left side also */
    }
    .header .status .left .triangle {
      /* color: #666; */
      color: black;
      cursor: pointer;
      margin: -10px;
      padding: 10px;
      margin-right: -5px;
      font-family: 'JetBrains Mono', monospace; /* consistent on iPhone */
      /* these improve vertical centering */
      display: inline-block;
      vertical-align: middle;
      margin-top: -17px;
    }
    .header .status .center {
      flex-grow: 2;
      display: flex;
      flex-direction: column;
      padding: 4px; /* minimal padding to avoid crowding title and subtitle */
      padding-left: 10px; /* extra padding to match padding of .left */
    }
    .header .status .center .title {
      color: #eee;
      font-weight: 700; /* bold */
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .header .status .center .subtitle {
      font-size: 70%;
      color: #777;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .header .status .center .subtitle .sharer-name {
      color: #aaa;
      font-weight: 700; /* bold */
    }
    .header .status .console-summary {
      flex-grow: .5;
      /* display: flex;
      justify-content: right;
      align-items: center; */
      line-height: 40px; /* align dots to middle of .user */
      min-width: min(20%, 40px) !important; /* ensure clickability */
      max-width: 20% !important;
      height: 100% !important;
      box-sizing: border-box !important;
      position: static !important; /* position inside flex */
      padding: 0 !important;
      text-align: right !important;
      -webkit-touch-callout: none !important;
      -webkit-user-select: none !important;
      user-select: none !important;
      cursor: pointer;
    }
    .header .status .console {
      top: 10px;
      right: 10px;
      left: auto;
      max-width: calc(100% - 20px); /* leave 10px on sides */
    }
    .items {
      padding-bottom: 0 !important;
    }
    /* .container > .item-menu,
    .item > div:first-child {
      display: none !important;
    } */
    .item > :is(.content, .deps-and-dependents) mark.label {
      display: none !important;
    }
    {#if items[0].title}
      .header + .super-container :is(h1,h2,h3,h4,h5,h6):first-of-type {
        display: none;
      }
      .header + .super-container :is(h1,h2,h3,h4,h5,h6):first-of-type + br {
        display: none;
      }
    {/if}
    .item > :is(.deps-summary, .dependents-summary) {
      display: none !important;
    }
  </style>
{/if}

{#if narrating}
  <style>
    .items {
      /* padding to make it easier to crop video */
      padding: 0 10px;
      padding-top: 10px;
      box-sizing: border-box; /* include added padding */
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
      transition: all 0.5s ease-out;
    }
    .webcam-background.intro {
      opacity: 1;
      pointer-events: all;
    }
    .webcam {
      /* background: #333; */
      width: 550px;
      height: 400px;
      max-width: 34.375vw;
      max-height: 25vw;
      position: fixed;
      bottom: 0;
      right: 0;
      z-index: 1000; /* above modal */
      /* box-shadow: 0px 0px 20px 5px black; */
      /* border: 5px solid white; */
      /* border-radius: 50%; */
      /* border-bottom: 1px solid #222; */
      border-radius: 10px;
      transition: all 0.5s ease-out;
    }
    .webcam.intro {
      width: 68.75vw;
      height: 50vw;
      max-width: 68.75vw;
      max-height: 50vw;
      right: 15.625vw;
    }
    .webcam-title {
      z-index: 1001; /* just above .webcam */
      color: white;
      font-weight: 600;
      font-size: 10px;
      position: fixed;
      bottom: 5px;
      right: 5px;
      padding: 5px 10px;
      background: rgba(0, 0, 0, 0.5);
      border-radius: 5px;
      transition: all 0.5s ease-out;
    }
    .webcam-title.intro {
      right: 50%;
      font-size: 30px;
      transform: translateX(50%);
    }
  </style>

  <div class="webcam-background" class:intro on:click|self={onWebcamClick} />
  <!-- svelte-ignore a11y-media-has-caption -->
  <video id="webcam-video" class="webcam" class:intro style="visibility: hidden; z-index:-100" />
  <canvas id="webcam-canvas" class="webcam" class:intro on:click|self={onWebcamClick} />
  <div class="webcam-title" class:intro />

  <script>
    if (navigator?.mediaDevices?.getUserMedia) {
      if (navigator.mediaDevices.enumerateDevices) {
        console.debug(
          `initializing webcam, config: '${localStorage.getItem('mindpage_narrating')}'; available devices:`
        )
        navigator.mediaDevices.enumerateDevices().then(devices => {
          devices.forEach(device => {
            if (device.kind == 'videoinput') console.debug(device.deviceId, device.label)
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
      _modal('unable to access webcam')
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
  {#if signedin}
    <!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=AW-11040878740"></script>
    <script>
      window.dataLayer = window.dataLayer || []
      function gtag() {
        dataLayer.push(arguments)
      }
      gtag('js', new Date())
      gtag('config', 'AW-11040878740')
    </script>
    <!-- Event snippet for Signed-in Page view conversion page -->
    <script>
      gtag('event', 'conversion', { send_to: 'AW-11040878740/R6I_CMmf0oQYEJTh2ZAp' })
    </script>
  {/if}
</svelte:head>

<style>
  :global(html) {
    font-family: 'Open Sans', sans-serif;
    font-weight: 400;
    /* Safari renders heavier fonts under default subpixel-antialiasing */
    -webkit-font-smoothing: antialiased;
    /* disable tap highlights on ios and android */
    -webkit-tap-highlight-color: transparent;
  }
  /* disable ligatures which can be confusing (especially in regexes and other places where the characters should remain separate) and can cause shifting and color bleeding for editor highlights and may also cause line wrapping issues (note this directive does not work if only applied to html/body)*/
  :global(*) {
    font-variant-ligatures: none;
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
    display: none; /* set in .visible */
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    justify-content: center;
    align-items: center;
    /* NOTE: if you add transparency, initial zero-height layout and unscrolled header will be visible */
    background: rgba(17, 17, 17, 1);
  }
  .loading.visible {
    display: flex;
  }
  .loading.translucent {
    background: rgba(17, 17, 17, 0.75);
  }
  .loading > :global(div) {
    opacity: 0.75;
  }
  .header {
    max-width: 100%;
    position: relative; /* for .history to attach to top */
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
  .header .editor :global(.backdrop:not(.focused)) {
    border: 1px solid transparent;
  }
  /* lighten solid border when top editor is focused */
  .header .editor :global(.backdrop.focused) {
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
    width: max-content;
    max-width: 100%;
    box-sizing: border-box;
    top: 2px; /* some spacing from border above */
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
  :is(.console, .console-summary) :global(.console-debug) {
    color: #666;
  }
  :is(.console, .console-summary) :global(.console-info) {
    color: #777;
  }
  :is(.console, .console-summary) :global(.console-log) {
    color: #999;
  }
  :is(.console, .console-summary) :global(.console-warn) {
    color: yellow;
  }
  :is(.console, .console-summary) :global(.console-error) {
    color: #f55;
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
    word-break: break-all;
  }
  .status .console-summary {
    position: absolute;
    left: 0;
    top: 0;
    padding-top: 4px;
    height: 24px; /* matches .status height(+padding) above */
    min-width: min(30%, 60px); /* ensure clickability */
    max-width: 30%; /* try not to cover center (item dots) */
    text-align: left;
    overflow: hidden;
    padding-left: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  .status.hasDots {
    cursor: pointer;
  }
  .status .dots {
    color: #666;
  }
  .status .counts {
    font-family: 'Open Sans', sans-serif;
    font-weight: 400;
    font-size: 13px;
    position: absolute;
    right: 0;
    top: 0;
    padding: 0px 4px;
    margin: 4px 0px;
    border-radius: 4px;
  }
  .status .counts :global(:is(.unit, .comma)) {
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

  /* single-column layout can remove margin since there is no concern of having columns w/ same width */
  .column:not(.multi-column) {
    margin-right: 1px; /* consistent w/ 1px padding-left of .super-container */
  }
  /* multi-column layout can add padding on left for symmetry */
  .items.multi-column {
    padding-left: 8px;
    box-sizing: border-box; /* include added padding */
  }

  .items:not(.focused) :global(.item-menu),
  .items:not(.focused) :global(.log-summary),
  .items:not(.focused) :global(.deps-summary),
  .items:not(.focused) :global(.dependents-summary),
  .items:not(.focused) :global(.deps-and-dependents) {
    opacity: 0.5 !important;
  }
  .items:not(.focused) :global(.column-padding),
  .items:not(.focused) :global(.header) {
    opacity: 0.5;
  }
  .items:not(.focused) .header :global(.buttons) {
    opacity: 0;
  }
  .items:not(.focused) :global(.super-container),
  .items:not(.focused) :global(.toggle) {
    opacity: 0.75;
  }
  .items:not(.focused) :global(.super-container.target_context) {
    opacity: 0.85;
  }
  .items:not(.focused) :global(.super-container:is(.target, .editing, .pushable, .previewable)) {
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
    margin: 4px 0;
    height: 72px; /* + margins = separatorHeight used in updateItemLayout */
    color: #444; /* same as time indicators */
    /* background: #171717; */
    background: repeating-linear-gradient(45deg, #171717, #171717 8px, #000 8px, #000 16px);
    font-size: 16px;
    font-weight: 600;
  }
  .section-separator .arrows {
    margin-bottom: 5px; /* aligns better w/ surrounding text */
    /* font-family: 'JetBrains Mono', monospace; */
    font-family: monospace; /* down arrow looks too large w/ JetBrains Mono */
    font-weight: 300;
    font-size: 40px;
  }
  .section-separator .arrows:first-of-type {
    margin-right: 3px; /* extra spacing for diagonal/sideways arrows pointing at other columns */
  }
  .section-separator .arrows:not(:first-of-type) {
    margin-right: -2px; /* remove some spacing next to down arrow */
  }
  .section-separator hr {
    display: none;
    /* display: inline-block; */
    vertical-align: middle;
    background: transparent;
    border: 0;
    border-top: 3px dashed #444;
    height: 0; /* disappears if both height and border are 0 */
    width: 25%;
    margin: 0 15px;
  }

  /* allow time strings to overlap preceding section separators */
  .section-separator + :global(.super-container.timed) {
    margin-top: -29px; /* align bottom of .time w/ bottom edge of separator */
  }
  .section-separator + :global(.super-container.timed .time) {
    margin-left: -1px; /* align w/ left edge of separator */
    margin-bottom: 9px; /* 4px + 5px compensation for .super-container margin-top */
    background: black;
    border-top-right-radius: 5px;
  }

  /* allow time strings to overlap preceding .toggle */
  .toggle + :global(.super-container.timed) {
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

  .history {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
  }
  .history-container {
    position: absolute;
    bottom: 0; /* align bottom of history w/ top of header */
    left: 0;
    right: 0;
    pointer-events: none;
  }
  .history-item {
    color: #444;
    pointer-events: auto;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    white-space: nowrap;
    max-width: 100%;
    box-sizing: border-box;
    overflow: hidden;
    text-overflow: ellipsis;
    border-radius: 4px;
    padding: 5px;
    padding-left: 17px; /* 10 for header, 10 for editor, +1 border, -4 margin, has to be updated if header padding-left is reduced <10 on smaller screens below */
    margin-bottom: 2px;
    width: fit-content;
    cursor: pointer;
  }
  .history-item.current {
    color: #777;
  }
  .history-item:last-child {
    padding-right: 180px; /* clears editor buttons */
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
