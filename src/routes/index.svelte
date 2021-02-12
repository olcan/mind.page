<script context="module" lang="ts">
  // NOTE: Preload function can be called on either client or server
  // See https://sapper.svelte.dev/docs#Preloading
  export async function preload(page, session) {
    return process["server-preload"](page, session);
  }
</script>

<script lang="ts">
  import _ from "lodash";
  import { isClient, firebase, firestore } from "../../firebase.js";
  import { Circle2 } from "svelte-loading-spinners";
  import Modal from "../components/Modal.svelte";
  import Editor from "../components/Editor.svelte";
  import Item from "../components/Item.svelte";
  export let items = [];
  export let error = null;
  let user = null;
  let deletedItems = [];
  let editingItems = [];
  let focusedItem = -1;
  let focused = false;
  let signedin = false;
  let anonymous = false;
  let readonly = false;
  let inverted = isClient && localStorage.getItem("mindpage_inverted") == "true";
  let modal;

  let evalStack = [];
  function addLineNumbers(code) {
    let lineno = 1;
    return code
      .split("\n")
      .map((line) => `/*${lineno++}*/ ${line}`)
      .join("\n");
  }

  function _item(name: string): any {
    if (!name) return null;
    let item;
    if (name.startsWith("#")) {
      // item is specified by unique label (i.e. name)
      const ids = idsFromLabel.get(name.toLowerCase());
      if (!ids || ids.length == 0) {
        console.error(`_item '${name}' not found`);
        return null;
      } else if (ids.length > 1) {
        console.error(`_item '${name}' is ambiguous (${ids.length} items)`);
        return null;
      }
      item = items[indexFromId.get(ids[0])];
    } else {
      // item is specified by id
      const index = indexFromId.get(name);
      if (index == undefined) {
        console.error(`_item '${name}' not found`);
        return null;
      }
      item = items[index];
    }
    return Object.freeze(new _Item(item.id)); // defined below
  }

  // _items returns any number of matches, most recent first
  function _items(label: string) {
    return _.sortBy((idsFromLabel.get(label.toLowerCase()) || []).map(_item), (item) => -item.time);
  }

  // _modal shows a modal dialog
  function _modal(options) {
    return modal.show(options);
  }

  // define window properties and functions
  if (isClient) {
    Object.defineProperty(window, "_user", {
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
    });
    Object.defineProperty(window, "_stack", { get: () => evalStack.slice() }); // return copy not reference
    Object.defineProperty(window, "_this", { get: () => _item(evalStack[evalStack.length - 1]) });
    Object.defineProperty(window, "_that", { get: () => _item(evalStack[0]) });
    window["_item"] = _item;
    window["_items"] = _items;
    window["_modal"] = _modal;
  }

  // private function for looking up item given its id
  // (throws "deleted" error if item has been deleted)
  function item(id: string) {
    const index = indexFromId.get(id);
    if (index == undefined) throw new Error(`item ${id} deleted`);
    return items[index];
  }

  class _Item {
    id: string;
    constructor(id) {
      this.id = id;
      // define _own_ _enumerable_ properties (e.g. for JSON.stringify)
      // https://stackoverflow.com/a/57179513
      for (const property of ["name"]) {
        const descriptor = Object.getOwnPropertyDescriptor(_Item.prototype, property);
        const modified_descriptor = Object.assign(descriptor, { enumerable: true });
        Object.defineProperty(this, property, modified_descriptor);
      }
    }
    // getters
    get name(): string {
      return item(this.id).name;
    }
    get label(): string {
      return item(this.id).labelText; // case-sensitive label
    }
    get time(): number {
      return item(this.id).time;
    }
    get text(): string {
      return item(this.id).text;
    }
    get length(): number {
      return item(this.id).text.length;
    }
    get hash(): number {
      return item(this.id).hash;
    }
    get deephash(): number {
      return item(this.id).deephash;
    }
    get index(): number {
      return item(this.id).index;
    }
    get position(): number {
      return item(this.id).index + 1;
    }
    get tags(): Array<string> {
      return item(this.id).tags;
    }
    get tags_raw(): Array<string> {
      return item(this.id).tagsRaw;
    }
    get tags_visible(): Array<string> {
      return item(this.id).tagsVisible;
    }
    get tags_hidden(): Array<string> {
      return item(this.id).tagsHidden;
    }
    get dependencies(): Array<string> {
      return item(this.id).deps;
    }
    get dependents(): Array<string> {
      return item(this.id).dependents;
    }
    get elem(): HTMLElement {
      return document.getElementById("super-container-" + this.id);
    }
    // log options for write_log and write_log_any, reset in eval()
    get log_options(): object {
      let _item = item(this.id);
      if (!_item.log_options) _item.log_options = {};
      return _item.log_options;
    }
    // general-purpose key-value store with session/item lifetime
    get store(): object {
      let _item = item(this.id);
      if (!_item.store) _item.store = {};
      return _item.store;
    }
    // key-value store synchronized into localStorage
    // (should always be accessed via this accessor to ensure updates)
    get local_store(): object {
      let _item = item(this.id);
      if (!_item.savedId) throw new Error("local_store is not available until item has been saved");
      const key = "mindpage_item_store_" + _item.savedId;
      if (!_item.local_store) _item.local_store = JSON.parse(localStorage.getItem(key)) || {};
      // dispatch save to localStorage
      setTimeout(() => {
        let _item = item(this.id);
        if (!_item || !_item.local_store) {
          localStorage.removeItem(key);
          return;
        }
        const obj = JSON.stringify(_item.local_store);
        if (obj == "{}") localStorage.removeItem(key);
        else localStorage.setItem(key, obj);
      });
      return _item.local_store;
    }
    // separate store used for debugging
    get debug_store(): object {
      let _item = item(this.id);
      if (!_item.debug_store) _item.debug_store = {};
      return _item.debug_store;
    }

    read(type: string = "", options: object = {}) {
      const item = items[this.index];
      let content = [];
      // include dependencies in order, _before_ item itself
      if (options["include_deps"]) {
        options["include_deps"] = false; // deps are recursive already
        item.deps.forEach((id) => {
          const dep = items[indexFromId.get(id)];
          // NOTE: we allow async dependents to be excluded so that "sync" items can still depend on async items for auto-updating or non-code content or to serve as a mix of sync/async items that can be selectively imported
          if (
            options["exclude_async_deps"] &&
            (dep.async || dep.deps.map((id) => items[indexFromId.get(id)].async).includes(true))
          )
            return; // exclude async dependency chain
          content.push(_item(id).read(type, options));
        });
      }
      // indicate item name in comments for certain types of reads
      if (type == "js" || type == "webppl") content.push(`/* ${type} @ ${item.name} */`);
      else if (type == "html") content.push(`<!-- ${type} @ ${item.name} -->`);
      let text = type ? extractBlock(item.text, type) : item.text;
      if (options["replace_ids"]) text = text.replace(/(^|[^\\])\$id/g, "$1" + item.id);
      content.push(text);
      // console.debug(content);
      return content.filter((s) => s).join("\n");
    }

    // "deep read" function with include_deps=true as default
    read_deep(type: string, options: object = {}) {
      return this.read(type, Object.assign({ include_deps: true }, options));
    }

    // read function intended for reading *_input blocks with code prefix
    read_input(type: string, options: object = {}) {
      return [
        this.read_deep(type, Object.assign({ replace_ids: true }, options)),
        this.read(type + "_input", options),
      ].join("\n");
    }

    // accessor for console log associated with item
    // default level (1) excludes debug messages
    // since can be "run" (default), "eval", or any epoch time (same as Date.now)
    // item can be "self" (default), specific item name (label or id), or "any"
    console_log(options = {}) {
      let since = options["since"] || "run";
      const level = options["level"] || 1;
      const name = options["item"] || "self";
      if (since == "run") since = item(this.id).lastRunTime;
      else if (since == "eval") since = item(this.id).lastEvalTime;
      else if (typeof since != "number") {
        console.error(`console_log: invalid since='${since}', should be "run", "eval", or number (ms since epoch)`);
        return [];
      }
      if (name != "self" && name != "any" && !item(name)) {
        console.error(`console_log: item '${name}' not found`);
        return [];
      }
      let log = [];
      const filter_id = name == "self" ? this.id : name == "any" ? "" : item(name).id;
      for (let i = consoleLog.length - 1; i >= 0; --i) {
        const entry = consoleLog[i];
        if (entry.time < since) break;
        if (entry.level < level) continue;
        if (filter_id && !entry.stack.includes(filter_id)) continue;
        let prefix = entry.type == "log" ? "" : entry.type.toUpperCase() + ": ";
        if (prefix == "WARN: ") prefix = "WARNING: ";
        log.push(prefix + entry.text);
      }
      return log.reverse();
    }

    write(text: string, type: string = "_output") {
      text = typeof text == "string" ? text : JSON.stringify(text);
      // confirm if write is too big
      const writeConfirmLength = 16 * 1024;
      if (text && text.length >= writeConfirmLength) {
        if (!confirm(`Write ${text.length} bytes (${type}) into ${this.name}?`)) return; // cancel write
      }
      // if writing *_log, clear any existing *_log blocks
      // (and skip write if block is empty)
      let __item = item(this.id); // writeable item
      if (type.endsWith("_log")) {
        __item.text = removeBlock(this.text, "\\w*?_log"); // remove existing *_log
        if (text) __item.text = appendBlock(this.text, type, text); // if empty, skip
      } else {
        if (type.trim() == "") __item.text = text;
        else __item.text = appendBlock(this.text, type, text);
      }
      if (!__item.log) __item.time = Date.now();
      itemTextChanged(this.index, this.text);
      // dispatch onEditorChange to prevent index changes during eval
      setTimeout(() => {
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange(editorText); // item time/text has changed
        saveItem(this.id);
      });
    }

    clear(type: string) {
      item(this.id).text = clearBlock(this.text, _.escapeRegExp(type));
    }

    remove(type: string) {
      item(this.id).text = removeBlock(this.text, _.escapeRegExp(type));
    }

    write_log(options = {}) {
      options = _.merge(
        {
          since: "run",
          level: 1,
          type: "_log",
          item: "self",
        },
        item(this.id).log_options, // may be undefined
        options
      );
      this.write(this.console_log(options).join("\n"), options["type"]);
      if (options["type"] == "_log" || options["show_logs"]) this.show_logs();
    }

    write_log_any(options = {}) {
      return this.write_log(Object.assign({ item: "any" }, item(this.id).log_options, options));
    }

    show_logs(autohide_after: number = 15000) {
      itemShowLogs(this.id, autohide_after);
    }

    // evaluates given code in context of this item
    eval(js: string = "", options: object = {}) {
      initItems(); // initialize items if not already done, usually due to macros at first render
      let prefix = this.read_deep(
        "js",
        Object.assign({ replace_ids: true, exclude_async_deps: !options["async"] }, options)
      );
      let evaljs = [prefix, js].join("\n").trim();
      if (!options["debug"]) {
        if (options["async"]) {
          // NOTE: async commands use a light-weight wrapper without output/logging into item
          if (options["trigger"] == "command") evaljs = ["(async () => {", evaljs, "})()"].join("\n");
          else evaljs = ["_this.start(async () => {", evaljs, "}) // _this.start"].join("\n");
        }
        if (options["trigger"]) evaljs = [`const __trigger = '${options["trigger"]}';`, evaljs].join("\n");
        evaljs = ["'use strict';null;", `const _id = '${this.id}';`, "const _this = _item(_id);", evaljs].join("\n");
      }
      // replace any remaining $id, $hash, $deephash, just like in macros or _html(_*) blocks
      evaljs = evaljs.replace(/(^|[^\\])\$id/g, "$1" + this.id);
      evaljs = evaljs.replace(/(^|[^\\])\$hash/g, "$1" + this.hash);
      evaljs = evaljs.replace(/(^|[^\\])\$deephash/g, "$1" + this.deephash);
      // store eval text under item.debug_store[trigger] for debugging, including a reverse stack string
      let stack = evalStack
        .map((id) => item(id).name)
        .concat(this.name)
        .reverse()
        .join(" < ");
      this.debug_store[options["trigger"] || "other"] = appendBlock(
        `\`eval(…)\` on ${stack}`,
        "js_input",
        addLineNumbers(evaljs)
      );
      // run eval within try/catch block
      item(this.id).lastEvalTime = Date.now();
      if (options["trigger"] == "run") {
        item(this.id).lastRunTime = Date.now();
        item(this.id).log_options = null;
      }
      evalStack.push(this.id);
      try {
        const out = eval.call(window, evaljs);
        if (evalStack.pop() != this.id) console.error("invalid stack");
        return out;
      } catch (e) {
        console.error(e);
        invalidateElemCache(this.id);
        if (evalStack.pop() != this.id) console.error("invalid stack");
        throw e;
      }
    }

    // starts an async evaluation in context of this item
    // item is NOT on stack unless added explicitly (see below)
    // log messages are NOT associated with item while it is off the stack
    // _this is still defined in lexical context as if item is top of stack
    // returns promise resolved/rejected once evaluation is done (w/ output) or triggers error
    start(async_func) {
      item(this.id).running = true;
      return new Promise((resolve, reject) => {
        // skip animation frame to ensure DOM is updated for running=true
        // (otherwise only option is an arbitrary delay since polling DOM does not work)
        // (see https://stackoverflow.com/a/57659371 and other answers to that question)
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            Promise.resolve(async_func())
              .then((output) => {
                if (output) this.write(output);
                this.write_log_any(); // customized via _this.log_options
                item(this.id).running = false;
                resolve(output);
              })
              .catch((e) => {
                console.error(e);
                invalidateElemCache(this.id);
                this.write_log_any(); // customized via _this.log_options
                item(this.id).running = false;
                reject(e);
              })
          )
        );
      });
    }

    // invokes given (sync) function after pushing item onto stack
    // re-returns any return value, rethrows (after logging) any errors
    invoke(func) {
      evalStack.push(this.id);
      try {
        const out = func();
        if (evalStack.pop() != this.id) console.error("invalid stack");
        return out;
      } catch (e) {
        console.error(e);
        invalidateElemCache(this.id);
        if (evalStack.pop() != this.id) console.error("invalid stack");
        throw e;
      }
    }

    // "attaches" given function to item such that it will go through _this.invoke()
    // useful for passing callback functions, e.g. into Promise.then(...)
    attach(func) {
      const _item = this; // capture for deferred function
      return function (...args) {
        _item.invoke(() => func(...args));
      };
    }

    // dispatch = setTimeout on attached function
    dispatch(func, ms, ...args) {
      setTimeout(this.attach(func), ms, ...args);
    }

    // promise = new Promise on attached executor function (resolve, reject) => {...}
    promise(func) {
      return new Promise(this.attach(func));
    }
  }

  function itemTimeString(delta: number) {
    if (delta < 60) return "<1m";
    if (delta < 3600) return Math.floor(delta / 60).toString() + "m";
    if (delta < 24 * 3600) return Math.floor(delta / 3600).toString() + "h";
    return Math.floor(delta / (24 * 3600)).toString() + "d";
  }

  let indexFromId;
  let headerdiv;
  let consolediv;
  let dotCount = 0;
  let columnCount = 0;
  let hideIndex = Infinity;
  // NOTE: truncation removes items from the page completely and speeds up updates (e.g. when searching or tapping tags). It is safe to do as long as the truncation index does not vary too much, which can trigger problems with async scripts that are not implemented properly, e.g. that do not use resume/defer/etc and throw errors or invoke invalidate_cache when target elements go missing. Currently truncation index is fixed but can still effectively vary when hideIndex > truncateIndex, which seems relative safe as it concerns items lower on the page, and larger indices which are unlikely to be toggled as frequently as smaller indices.
  const truncateIndex = 50;
  let tailIndices = [];
  let newestTime = 0;
  let oldestTime = Infinity;
  let oldestTimeString = "";
  let defaultHeaderHeight = 0;
  let defaultItemHeight = 0; // if zero, initial layout will be single-column
  let totalItemHeight = 0;
  let firstLayoutTime = 0;
  let lastLayoutTime = 0;
  let lastTimeStringUpdateTime = 0;

  function updateItemLayout() {
    // console.debug("updateItemLayout");
    editingItems = [];
    focusedItem = -1;
    indexFromId = new Map<string, number>();
    dotCount = 0;

    // NOTE: we use document width as it scales with font size consistently on iOS and Mac
    const documentWidth = document.documentElement.clientWidth;
    const minColumnWidth = 500; // minimum column width for multiple columns
    columnCount = Math.max(1, Math.floor(documentWidth / minColumnWidth));
    let columnHeights = new Array(columnCount).fill(0);
    let columnItems = new Array(columnCount).fill(-1);
    let columnTopMovers = new Array(columnCount).fill(items.length);
    columnHeights[0] = headerdiv ? headerdiv.offsetHeight : defaultHeaderHeight; // first column includes header
    let lastTimeString = "";
    newestTime = 0;
    oldestTime = Infinity;
    oldestTimeString = "";
    totalItemHeight = 0;
    lastLayoutTime = Date.now();
    lastTimeStringUpdateTime = Date.now();
    if (!firstLayoutTime) firstLayoutTime = lastLayoutTime;
    // NOTE: updateItemLayout can ONLY increase hideIndex, and this is intentional to avoid abrupt hiding of items due to non-ranking layout updates (page width changes and item height changes) and ensure that only re-ranking actions can trigger re-hiding of items

    items.forEach((item, index) => {
      item.lastIndex = index;
      item.index = index;
      indexFromId.set(item.id, index);
      if (item.dotted) dotCount++;
      if (item.editing) {
        editingItems.push(index);
        // extend hide index to include any editing items
        if (index >= hideIndex) hideIndex = index + 1;
      }
      if (item.focused) focusedItem = index;

      // extend hide index to include all items touched in this session (after first layout)
      if (item.time > firstLayoutTime && index >= hideIndex) hideIndex = index + 1;

      let lastItem = items[index - 1];
      let timeString = itemTimeString((Date.now() - item.time) / 1000);
      if (item.time < oldestTime) {
        oldestTime = item.time;
        oldestTimeString = timeString;
      }
      if (item.time > newestTime) newestTime = item.time;

      item.timeString = "";
      item.timeOutOfOrder = false;
      if (!item.pinned && (index == 0 || timeString != lastTimeString)) {
        item.timeString = timeString;
        item.timeOutOfOrder =
          index > 0 && !lastItem.pinned && item.time > lastItem.time && timeString != lastTimeString;
        lastTimeString = timeString; // for grouping of subsequent items
      }

      // calculate item height (zero if dotted, or not yet calculated and default is zero)
      item.outerHeight = item.dotted ? 0 : item.height || defaultItemHeight;
      // add item margins + time string height
      if (item.outerHeight > 0) item.outerHeight += 8 + (item.timeString ? 24 : 0);
      totalItemHeight += item.height; // used to hide items until height available

      // determine item column
      item.nextColumn = -1;
      item.nextItemInColumn = -1;

      item.lastColumn = item.column;
      if (index == 0) item.column = 0;
      else {
        // stay on same column unless column height would exceed minimum column height by 90% of screen height
        const lastColumn = lastItem.column;
        const minColumnHeight = Math.min(...columnHeights);
        if (
          columnHeights[lastColumn] <= minColumnHeight + 0.5 * outerHeight ||
          columnHeights[lastColumn] + item.outerHeight + 40 <= minColumnHeight + 0.9 * outerHeight
        )
          item.column = lastColumn;
        else item.column = columnHeights.indexOf(minColumnHeight);
        if (item.column != lastColumn) {
          lastItem.nextColumn = item.column;
          lastItem.arrows = item.column < lastColumn ? "↖" : "";
          for (let i = 0; i < Math.abs(item.column - lastColumn) - 1; ++i)
            lastItem.arrows += item.column < lastColumn ? "←" : "→";
          lastItem.arrows += item.column < lastColumn ? "" : "↗";
          columnHeights[lastColumn] += 40; // .section-separator height including margins
        }
      }
      // record item as top mover if it is lowest-index item that moved in its column
      const moved = item.index != item.lastIndex || item.column != item.lastColumn;
      if (moved && item.index < columnTopMovers[item.column]) columnTopMovers[item.column] = item.index;

      // if non-dotted item is first in its column and missing time string, add it now
      if (!item.dotted && columnItems[item.column] < 0 && !item.timeString) {
        item.timeString = timeString;
        lastTimeString = timeString; // for grouping of subsequent items
        // add time string height now, assuming we are not ignoring item height
        if (item.outerHeight > 0) item.outerHeight += 24;
      }
      columnHeights[item.column] += item.outerHeight;
      if (columnItems[item.column] >= 0) {
        items[columnItems[item.column]].nextItemInColumn = index;
        // if item is below section-separator and has timeString, discount -24px negative margin
        if (columnItems[item.column] != index - 1 && item.timeString) columnHeights[item.column] -= 24;
      }
      columnItems[item.column] = index;
    });

    if (focusedItem >= 0) {
      // maintain focus/selection
      let textarea = textArea(focusedItem);
      if (textarea) {
        let selectionStart = textarea.selectionStart;
        let selectionEnd = textarea.selectionEnd;
        setTimeout(() => {
          textarea = textArea(focusedItem);
          if (!textarea) return;
          textarea.focus();
          textarea.selectionStart = selectionStart;
          textarea.selectionEnd = selectionEnd;
        }); // allow dom update before refocus
      }
    }
    // scroll up to top moved item if necessary
    if (_.min(columnTopMovers) < items.length) {
      // allow dom update before calculating scroll position
      const lastLayoutTimeAtDispatch = lastLayoutTime;
      setTimeout(() => {
        if (lastLayoutTime != lastLayoutTimeAtDispatch) return; // cancel
        const itemTop = _.min(
          columnTopMovers.map((index) => {
            if (index == items.length) return Infinity;
            const div = document.querySelector("#super-container-" + items[index].id);
            if (!div) return Infinity; // item hidden
            return (div as HTMLElement).offsetTop;
          })
        );
        if (itemTop < window.scrollY) window.top.scrollTo(0, itemTop < outerHeight / 2 ? 0 : itemTop);
      });
    }
  }

  function isSpecialTag(tag) {
    return (
      tag == "#log" ||
      tag == "#menu" ||
      tag == "#context" ||
      tag == "#init" ||
      tag == "#async" ||
      tag == "#debug" ||
      tag.match(/^#pin(?:\/|$)/) ||
      tag.match(/\/pin(?:\/|$)/)
    );
  }

  // returns "alternative tags" for dependency analysis and tag search/highlights
  function altTags(tag) {
    if (tag == "#log") return [];
    // ["#features/log"]; // visible tag does not need an alt
    else if (tag == "#menu") return ["#features/_menu"];
    else if (tag == "#context") return ["#features/_context"];
    else if (tag == "#init") return ["#features/_init"];
    else if (tag == "#async") return ["#features/_async"];
    else if (tag.match(/(?:\/|#)pin(?:\/|$)/)) return ["#features/_pin"];
    else return [];
  }

  function tagPrefixes(tag) {
    let pos;
    let prefixes = [];
    while ((pos = tag.lastIndexOf("/")) >= 0) prefixes.push((tag = tag.slice(0, pos)));
    return prefixes;
  }

  function stableSort(array, compare) {
    return array
      .map((item, index) => ({ item, index }))
      .sort((a, b) => compare(a.item, b.item) || a.index - b.index)
      .map(({ item }) => item);
  }

  // NOTE: Invoke onEditorChange only editor text and/or item content has changed.
  //       Invoke updateItemLayout directly if only item sizes have changed.
  const editorDebounceTime = 500;
  let lastEditorChangeTime = 0;
  let matchingItemCount = 0;
  let textLength = 0;
  let editorChangePending = false;
  let finalizeStateOnEditorChange = false;
  let replaceStateOnEditorChange = false;
  let hideIndexFromRanking = Infinity;

  function onEditorChange(text: string) {
    // keep history entry 0 updated, reset index on changes
    if (text != sessionHistory[sessionHistoryIndex]) {
      sessionHistoryIndex = 0;
      if (sessionHistory.length == 0) sessionHistory = [text];
      else sessionHistory[0] = text;
    }

    // if editor is non-empty, has focus, and it is too soon since last change/return, debounce
    // NOTE: non-empty condition is dropped if last call was debounced, otherwise backspace can stall on first char
    text = text.toLowerCase().trim();
    if (
      (text.length > 0 || lastEditorChangeTime < Infinity) &&
      document.activeElement == textArea(-1) &&
      Date.now() - lastEditorChangeTime < editorDebounceTime
    ) {
      lastEditorChangeTime = Date.now(); // reset timer at each postponed change
      if (!editorChangePending) {
        editorChangePending = true;
        setTimeout(() => {
          editorChangePending = false;
          onEditorChange(editorText);
        }, editorDebounceTime);
      }
      return;
    }
    lastEditorChangeTime = Infinity; // force minimum wait for next change
    const start = Date.now();

    text = text.toLowerCase().trim();
    const tags = parseTags(text);
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
            tags.all.map((t) => {
              if (tagCounts.get(t) > 0) return [];
              // if (idsFromLabel.get(t)?.length > 0) return [];
              return [t.substring(1)].concat(tagPrefixes(t.substring(1))).concat(t.split("/"));
            })
          )
        )
    ).filter((t) => t);
    // disable search for text starting with '/', to provide a way to disable search, and to ensure search results do not interfere with commands that create new items or modify existing items
    // if (text.startsWith("/")) terms = [];

    // expand tag prefixes into termsContext
    let termsContext = _.flatten(tags.all.map(tagPrefixes));

    matchingItemCount = 0;
    textLength = 0;
    let listing = [];
    let context = [];
    let listingItemIndex = -1;
    let idMatchItemIndices = [];

    // determine "listing" item w/ unique label matching first term
    // (in reverse order w/ listing item label last so larger is better and missing=-1)
    if (terms[0] != "#log" && idsFromLabel.get(terms[0])?.length == 1) {
      listingItemIndex = indexFromId.get(idsFromLabel.get(terms[0])[0]);
      let item = items[listingItemIndex];
      context = [item.label].concat(item.labelPrefixes);
      // expand context to include "context" items that visibly tag the top item in context
      // (also add their label to context terms so they are highlighted as context as well)
      while (true) {
        const lastContextLength = context.length;
        items.forEach((ctxitem) => {
          if (ctxitem.id == item.id) return;
          if (
            ctxitem.context &&
            ctxitem.labelUnique &&
            !context.includes(ctxitem.label) &&
            _.intersection(ctxitem.tagsVisible, context).length > 0
          ) {
            context.push(ctxitem.label);
            if (ctxitem.labelPrefixes.length > 0) context = _.uniq(context.concat(ctxitem.labelPrefixes));
          }
        });
        if (context.length == lastContextLength) break;
      }
      termsContext = _.uniq(termsContext.concat(context));

      listing = item.tagsVisible
        .filter((t) => t != item.label)
        .slice()
        .reverse()
        .concat(item.label);
      // console.debug(listing);
    }

    items.forEach((item, index) => {
      textLength += item.text.length;

      // match query terms against visible tags (+prefixes) in item
      item.tagMatches = _.intersection(item.tagsVisibleExpanded, terms).length;

      // prefix-match first query term against item header text
      // (only for non-tags or unique labels, e.g. not #todo prefix once applied to multiple items)
      item.prefixMatch =
        item.header.startsWith(terms[0]) &&
        (!terms[0].startsWith("#") || (idsFromLabel.get(terms[0]) || []).length <= 1);

      // find "pinned match" term = hidden tags containing /pin with prefix match on first term
      item.pinnedMatchTerm = item.tagsHidden.find((t) => t.startsWith(terms[0]) && t.match(/\/pin(?:\/|$)/)) || "";
      item.pinnedMatch = item.pinnedMatchTerm.length > 0;

      // set uniqueLabel for shortening code below
      // NOTE: doing this here is easier than keeping these updated in itemTextChanged
      item.uniqueLabel = item.labelUnique ? item.label : "";
      // item.uniqueLabelPrefixes = item.labelUnique ? item.labelPrefixes : [];

      // match tags against item tagsAlt (expanded using altTags), allowing prefix matches
      item.matchingTerms = terms.filter((t) => t[0] == "#" && item.tagsAlt.findIndex((tag) => tag.startsWith(t)) >= 0);

      // match all terms (tag or non-tag) anywhere in text
      item.matchingTerms = item.matchingTerms.concat(terms.filter((t) => item.lctext.includes(t)));

      // match regex:* terms as regex
      item.matchingTerms = item.matchingTerms.concat(
        terms.filter((t) => t.match(/^regex:\S+/) && item.lctext.match(new RegExp(t.substring(6))))
      );
      // match id:* terms against id
      const idMatchTerms = terms.filter((t) => t.match(/^id:\w+/) && item.id.toLowerCase() == t.substring(3));
      item.matchingTerms = item.matchingTerms.concat(idMatchTerms);
      if (idMatchTerms.length > 0) idMatchItemIndices.push(index);
      item.matchingTerms = _.uniq(item.matchingTerms); // can have duplicates (e.g. regex:*, id:*, ...)

      // match "secondary terms" ("context terms" against expanded tags, non-tags against item deps/dependents)
      item.matchingTermsSecondary = _.uniq(
        _.concat(
          termsContext.filter(
            (t) =>
              item.tagsExpanded.includes(t) ||
              item.depsString.toLowerCase().includes(t) ||
              item.dependentsString.toLowerCase().includes(t) ||
              item.label.includes(t) // to prevent deps/dependent matches dominating labeled item
          ),
          terms.filter(
            (t) =>
              item.depsString.toLowerCase().includes(t) ||
              item.dependentsString.toLowerCase().includes(t) ||
              item.label.includes(t) // to prevent deps/dependent matches dominating labeled item
          )
        )
      );

      // item is considered matching if primary terms match
      // (i.e. secondary terms are used only for ranking and highlighting matching tag prefixes)
      // (this is consistent with .index.matching in Item.svelte)
      if (item.matchingTerms.length > 0) matchingItemCount++;

      // calculate missing tags (excluding certain special tags from consideration)
      // NOTE: doing this here is easier than keeping these updated in itemTextChanged
      // NOTE: tagCounts include prefix tags, deduplicated at item level
      item.missingTags = item.tags.filter((t) => t != item.label && !isSpecialTag(t) && (tagCounts.get(t) || 0) <= 1);
      // allow special tags to be missing if they are visible
      item.missingTags = item.missingTags.concat(
        item.tagsVisible.filter((t) => t != item.label && isSpecialTag(t) && (tagCounts.get(t) || 0) <= 1)
      );
      // if (item.missingTags.length > 0) console.debug(item.missingTags, item.tags);

      item.hasError = item.text.match(/(?:^|\n)(?:ERROR|WARNING):/) != null;
    });

    // Update (but not save yet) times for editing and running non-log items to maintain ordering
    // among running/editing items within their sort level (see ordering logic below)
    let now = Date.now();
    items.forEach((item) => {
      if ((item.editing || item.running) && !item.log) item.time = now;
    });

    // Update time for listing item (but not save yet, a.k.a. "soft touch")
    // NOTE: we may add a few ms to the current time to dominate other recent touches (e.g. tag clicks)
    if (listingItemIndex >= 0 && !items[listingItemIndex].log) items[listingItemIndex].time = Date.now() + 2; // prioritize

    // Update times for id-matching items (but not save yet, a.k.a. "soft touch")
    idMatchItemIndices.forEach((index) => {
      if (!items[index].log) items[index].time = Date.now() + 1; // prioritize
    });

    // update history, replace unless current state is final (from tag click)
    if (history.state.editorText != editorText) {
      // need to update history
      const state = {
        editorText: editorText,
        unsavedTimes: _.compact(
          items.map((item) => (item.time != item.savedTime ? _.pick(item, ["id", "time"]) : null))
        ),
        final: !editorText || finalizeStateOnEditorChange,
      };
      // console.debug(history.state.final ? "push" : "replace", state);
      if (history.state.final && !replaceStateOnEditorChange) history.pushState(state, editorText);
      else history.replaceState(state, editorText);
    }
    finalizeStateOnEditorChange = false; // processed above
    replaceStateOnEditorChange = false; // processed above

    // insert dummy item with time=now to determine (below) index after which items are ranked purely by time
    items.push({
      dotted: false,
      dotTerm: "",
      pinned: false,
      pinTerm: "",
      pinnedMatch: false,
      pinnedMatchTerm: "",
      uniqueLabel: "",
      editing: false,
      tagMatches: 0,
      prefixMatch: false,
      matchingTerms: [],
      matchingTermsSecondary: [],
      missingTags: [],
      hasError: false,
      time: Date.now(),
      id: null,
    });

    // returns position of minimum non-negative number, or -1 if none found
    function min_pos(xJ) {
      let jmin = -1;
      for (let j = 0; j < xJ.length; ++j) if (xJ[j] >= 0 && (jmin < 0 || xJ[j] < xJ[jmin])) jmin = j;
      return jmin;
    }

    // NOTE: this assignment is what mainly triggers toHTML in Item.svelte
    //       (even assigning a single index, e.g. items[0]=items[0] triggers toHTML on ALL items)
    //       (afterUpdate is also triggered by the various assignments above)
    // NOTE: undefined values produce NaN, which is treated as 0
    items = stableSort(
      items,
      (a, b) =>
        // dotted? (contains #_pin/dot or #_pin/dot/*)
        b.dotted - a.dotted ||
        // alphanumeric ordering on #_pin/dot/* term (see https://stackoverflow.com/a/38641281)
        a.dotTerm.localeCompare(b.dotTerm, undefined, {
          numeric: true,
          sensitivity: "base",
        }) ||
        // pinned? (contains #_pin or #_pin/*)
        b.pinned - a.pinned ||
        // alphanumeric ordering on #_pin/* term
        a.pinTerm.localeCompare(b.pinTerm, undefined, {
          numeric: true,
          sensitivity: "base",
        }) ||
        // pinned match? (contains /pin or /pin/*)
        b.pinnedMatch - a.pinnedMatch ||
        // alphanumeric ordering on #*/pin/* term
        a.pinnedMatchTerm.localeCompare(b.pinnedMatchTerm, undefined, {
          numeric: true,
          sensitivity: "base",
        }) ||
        // log items matching #log query ordered by time
        (text == "#log" && b.log ? b.time : 0) - (text == "#log" && a.log ? a.time : 0) ||
        // listing item context position (includes labelPrefixes)
        context.indexOf(b.uniqueLabel) - context.indexOf(a.uniqueLabel) ||
        // position of (unique) label in listing item (item w/ unique label = first term)
        // (listing is reversed so larger index is better and missing=-1)
        listing.indexOf(b.uniqueLabel) - listing.indexOf(a.uniqueLabel) ||
        // editing mode (except log items)
        (!b.log && b.editing) - (!a.log && a.editing) ||
        // # of matching (visible) tags from query
        b.tagMatches - a.tagMatches ||
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
    );

    // determine "tail" index after which items are ordered purely by time
    let tailIndex = items.findIndex((item) => item.id === null);
    items.splice(tailIndex, 1);
    tailIndex = Math.max(1, tailIndex);
    let tailTime = items[tailIndex]?.time || 0;
    hideIndex = tailIndex; // can be increased below in updateItemLayout

    // determine other non-trivial "tail times" <= tailTime but > oldestTime
    const tailTime24h = Date.now() - 24 * 3600 * 1000;
    const tailTime7d = Date.now() - 7 * 24 * 3600 * 1000;
    const tailTime30d = Date.now() - 30 * 24 * 3600 * 1000;
    tailIndices = [];
    if (tailTime24h <= tailTime) {
      const extendedTailIndex = tailIndex + items.slice(tailIndex).filter((item) => item.time >= tailTime24h).length;
      // if no matching items, show last 24h, so take extendedTailIndex (even if == items.length)
      // if (matchingItemCount == 0) hideIndex = extendedTailIndex;
      if (extendedTailIndex > tailIndex && extendedTailIndex < items.length) {
        tailIndices.push({ index: extendedTailIndex, timeString: "24 hours", time: items[extendedTailIndex].time });
        tailIndex = extendedTailIndex;
        tailTime = items[extendedTailIndex].time;
      }
    }
    if (tailTime7d <= tailTime) {
      const extendedTailIndex = tailIndex + items.slice(tailIndex).filter((item) => item.time >= tailTime7d).length;
      if (extendedTailIndex > tailIndex && extendedTailIndex < items.length) {
        tailIndices.push({ index: extendedTailIndex, timeString: "7 days", time: items[extendedTailIndex].time });
        tailIndex = extendedTailIndex;
        tailTime = items[extendedTailIndex].time;
      }
    }
    if (tailTime30d <= tailTime) {
      const extendedTailIndex = tailIndex + items.slice(tailIndex).filter((item) => item.time >= tailTime30d).length;
      if (extendedTailIndex > tailIndex && extendedTailIndex < items.length) {
        tailIndices.push({ index: extendedTailIndex, timeString: "30 days", time: items[extendedTailIndex].time });
        tailIndex = extendedTailIndex;
        tailTime = items[extendedTailIndex].time;
      }
    }
    // console.debug(tailIndices);

    updateItemLayout();
    lastEditorChangeTime = Infinity; // force minimum wait for next change
    setTimeout(updateDotted, 0); // show/hide dotted/undotted items

    // save the final hide index calculated after each ranking (+layout)
    // used to determine where to show "hide older items" button
    // subsequent non-ranking layout updates can not change this OR decrease hide index, so hiding of elements can only happen during ranking
    hideIndexFromRanking = hideIndex;

    if (Date.now() - start >= 100) console.warn("onEditorChange took", Date.now() - start, "ms");
  }

  function onTagClick(id: string, tag: string, reltag: string, e: MouseEvent) {
    const index = indexFromId.get(id);
    if (index == undefined) return; // deleted
    // "soft touch" item if not already newest and not pinned and not log
    if (items[index].time > newestTime) console.warn("invalid item time");
    else if (items[index].time < newestTime && !items[index].pinned && !items[index].log)
      items[index].time = Date.now();

    // NOTE: Rendered form of tag should be renderTag(reltag). We use common suffix to map click position.
    const rendered = renderTag(reltag);
    let suffix = rendered;
    while (!tag.endsWith(suffix)) suffix = suffix.substring(1);
    if (suffix) {
      // calculate partial tag prefix (e.g. #tech for #tech/math) based on position of click
      let range = document.caretRangeFromPoint(
        e.pageX - document.documentElement.scrollLeft,
        e.pageY - document.documentElement.scrollTop
      );
      if (range) {
        let tagNode = e.target as Node;
        // if target is not the tag node, it must be a highlight, so we move to the parent
        if ((tagNode as HTMLElement).tagName != "MARK") tagNode = tagNode.parentNode;
        // console.debug("tag click: ", range.startOffset, clickNode, tagNode.childNodes);
        // if tag node contains highlight, we have to adjust click position
        let pos = range.startOffset;
        for (const child of Array.from(tagNode.childNodes)) {
          if (child.contains(range.startContainer)) break;
          pos += child.textContent.length;
        }
        // adjust pos from rendered to full tag ...
        pos = Math.max(pos, rendered.length - suffix.length);
        pos = tag.length - suffix.length + (pos - (rendered.length - suffix.length));
        // we only take partial tag if the current tag is "selected" (i.e. full exact match)
        // (makes it easier to click on tags without accidentally getting a partial tag)
        // if ((tagNode as HTMLElement).classList.contains("selected"))
        tag = tag.substring(0, pos) + tag.substring(pos).match(/^[^\/]*/)[0];
      } else {
        console.warn("got null range for tag click: ", tag, e);
      }
    } else {
      // NOTE: this can happen for link tags where rendered text is arbitrary, and without a common suffix we just take the full tag
      // console.warn("could not find matching suffix", tag, rendered);
    }
    tag = tag.replace(/^#_/, "#"); // ignore hidden tag prefix
    // if (editorText.trim() == tag) {
    //   history.back();
    //   return;
    // }
    editorText = editorText.trim() == tag ? "" : tag + " "; // space in case more text is added
    // editorText = tag + " ";
    finalizeStateOnEditorChange = true; // finalize state
    lastEditorChangeTime = 0; // disable debounce even if editor focused
    onEditorChange(editorText);
  }

  function onLinkClick(id: string, href: string, e: MouseEvent) {
    const index = indexFromId.get(id);
    if (index == undefined) return; // deleted
    // "soft touch" item if not already newest and not pinned and not log
    if (items[index].time > newestTime) console.warn("invalid item time");
    else if (items[index].time < newestTime && !items[index].pinned && !items[index].log) {
      items[index].time = Date.now();
      onEditorChange(editorText); // item time has changed
    }
  }

  function onLogSummaryClick(id: string) {
    let index = indexFromId.get(id);
    if (index == undefined) return;
    items[index].showLogs = !items[index].showLogs;
    items[index].showLogsTime = Date.now(); // invalidates auto-hide
  }

  function admin() {
    return (
      user &&
      user.uid == "y2swh7JY2ScO5soV7mJMHVltAOX2" &&
      (location.host == "mindbox.io" || location.href.match(/user=(?:anonymous|admin)/))
    );
  }

  function onPopState(e) {
    readonly = anonymous && !admin();
    if (!e?.state) return; // for fragment (#id) hrefs
    // console.debug("pop", e.state);
    // restore editor text and unsaved times
    editorText = e.state.editorText || "";
    if (e.state.unsavedTimes) {
      items.forEach((item) => (item.time = item.savedTime));
      e.state.unsavedTimes.forEach((entry) => {
        const index = indexFromId.get(entry.id);
        if (index == undefined) return;
        items[index].time = entry.time;
      });
    }
    lastEditorChangeTime = 0; // disable debounce even if editor focused
    onEditorChange(editorText);
  }

  function resetUser() {
    user = null;
    // NOTE: we do not modify secret since resetUser() is used for initialization in onAuthStateChanged
    localStorage.removeItem("mindpage_user");
    window.sessionStorage.removeItem("mindpage_signin_pending");
    document.cookie = "__session=;max-age=0"; // delete cookie for server
  }

  let signingOut = false;
  function signOut() {
    if (window.sessionStorage.getItem("mindpage_signin_pending")) return; // can not signout during signin
    signingOut = true;
    localStorage.removeItem("mindpage_secret"); // also remove secret when signing out
    // blur active element as caret can show through loading div
    // (can require dispatch on chrome if triggered from active element)
    setTimeout(() => (document.activeElement as HTMLElement).blur());
    resetUser();
    firebase()
      .auth()
      .signOut()
      .then(() => {
        console.log("signed out");
        location.reload();
      })
      .catch(console.error);
  }

  let idsFromLabel = new Map<string, string[]>();
  function itemDeps(index, deps = []) {
    let item = items[index];
    if (deps.includes(item.id)) return deps;
    // NOTE: dependency order matters for hashing and potentially for code import
    deps = [item.id].concat(deps); // prepend temporarily to avoid cycles, moved to back below
    const root = deps.length == 1;
    item.tagsHiddenAlt.forEach((tag) => {
      // NOTE: we allow special tags as dependents if corresponding uniquely named items exist
      // if (isSpecialTag(tag)) return;
      if (!idsFromLabel.has(tag)) return;
      const ids = idsFromLabel.get(tag);
      if (ids.length > 1) return; // only unique labels can have dependents
      ids.forEach((id) => {
        const dep = indexFromId.get(id);
        if (dep == undefined) return; // deleted
        deps = itemDeps(dep, deps);
      });
    });
    return root ? deps.slice(1) : deps.slice(1).concat(item.id);
  }

  function itemDepsString(item) {
    return item.deps
      .map((id) => {
        const dep = items[indexFromId.get(id)];
        const async = dep.async || dep.deps.map((id) => items[indexFromId.get(id)].async).includes(true);
        return dep.name + (async ? "(async)" : "");
      })
      .join(" ");
  }

  function itemDependentsString(item) {
    return item.dependents
      .map((id) => {
        const dep = items[indexFromId.get(id)];
        const visible = item.labelUnique && dep.tagsVisible.includes(item.label);
        return dep.name + (visible ? "(visible)" : "");
      })
      .join(" ");
  }

  let tagCounts = new Map<string, number>();
  function itemTextChanged(index: number, text: string, update_deps = true) {
    // console.debug("itemTextChanged", index);
    let item = items[index];
    item.hash = hashCode(text);
    item.lctext = text.toLowerCase();
    item.runnable = item.lctext.match(/\s*```js_input(?:_hidden|_removed)?(?:\s|$)/);
    item.scripted = item.lctext.match(/<script.*?>/);
    item.macroed = item.lctext.match(/<<.*?>>/);

    const tags = parseTags(item.lctext);
    item.tags = tags.all;
    item.tagsVisible = tags.visible;
    item.tagsHidden = tags.hidden;
    item.tagsRaw = tags.raw;
    item.tagsAlt = _.uniq(_.flattenDeep(item.tags.concat(item.tags.map(altTags))));
    item.tagsHiddenAlt = _.uniq(_.flattenDeep(item.tagsHidden.concat(item.tagsHidden.map(altTags))));
    item.log = item.tagsRaw.includes("#_log"); // can also be visible label #log, see below
    item.context = item.tagsRaw.includes("#_context");
    item.init = item.tagsRaw.includes("#_init");
    item.async = item.tagsRaw.includes("#_async");
    item.debug = item.tagsRaw.includes("#_debug");
    const pintags = item.tagsRaw.filter((t) => t.match(/^#_pin(?:\/|$)/));
    item.pinned = pintags.length > 0;
    item.pinTerm = pintags[0] || "";
    item.dotted = pintags.findIndex((t) => t.match(/^#_pin\/dot(?:\/|$)/)) >= 0;
    item.dotTerm = pintags.filter((t) => t.match(/^#_pin\/dot(?:\/|$)/))[0] || "";

    // if item stats with #tag or #_tag, it is taken as a "label" for the item
    // (we allow some html tags/macros to precede the label tag for styling purposes)
    // (we make starting #_label visible as #label in header to allow prefix matching)
    const prevLabel = item.label;
    item.header = item.lctext
      .replace(/^<.*>\s+#/, "#")
      .replace(/^#_/, "#")
      .match(/^.*?(?:\n|$)/)[0];
    item.label = item.header.startsWith(item.tags[0]) ? item.tags[0] : "";
    // if (item.label && item.label != item.tagsVisible[0]) console.warn("hidden label", item.label);
    item.labelText = item.label ? item.text.replace(/^<.*>\s+#/, "#").match(/^#\S+/)[0] : "";
    if (item.labelUnique == undefined) item.labelUnique = false;
    if (item.labelPrefixes == undefined) item.labelPrefixes = [];
    if (item.label) {
      // convert relative tags to absolute
      const resolveTag = (tag) => (tag.startsWith("#/") ? item.label + tag.substring(1) : tag);
      item.tags = item.tags.map(resolveTag);
      item.tagsVisible = item.tagsVisible.map(resolveTag);
      item.tagsHidden = item.tagsHidden.map(resolveTag);
      item.tagsRaw = item.tagsRaw.map(resolveTag);
      item.tagsAlt = item.tagsAlt.map(resolveTag);
      item.tagsHiddenAlt = item.tagsHiddenAlt.map(resolveTag);
    }
    if (item.label != prevLabel) {
      item.labelUnique = false;
      if (prevLabel) {
        const ids = idsFromLabel.get(prevLabel).filter((id) => id != item.id);
        idsFromLabel.set(prevLabel, ids);
        if (ids.length == 1) items[indexFromId.get(ids[0])].labelUnique = true;
      }
      if (item.label) {
        const ids = (idsFromLabel.get(item.label) || []).concat(item.id);
        idsFromLabel.set(item.label, ids);
        item.labelUnique = ids.length == 1;
        if (ids.length == 2) items[indexFromId.get(ids[0])].labelUnique = false;
      }
      item.labelPrefixes = [];
      let label = item.label;
      let pos;
      while ((pos = label.lastIndexOf("/")) >= 0) item.labelPrefixes.push((label = label.slice(0, pos)));
    }
    // name is always unique and either unique label or id:<id>
    item.name = item.labelUnique ? item.labelText : "id:" + item.id;

    // #log label designates log items and is never considered unique
    if (item.label == "#log") {
      item.log = true;
      item.labelUnique = false;
    }

    // compute expanded tags including prefixes
    const prevTagsExpanded = item.tagsExpanded || [];
    item.tagsExpanded = item.tags.slice();
    item.tags.forEach((tag) => {
      item.tagsExpanded = item.tagsExpanded.concat(tagPrefixes(tag));
    });
    item.tagsExpanded = _.uniq(item.tagsExpanded);
    if (!_.isEqual(item.tagsExpanded, prevTagsExpanded)) {
      prevTagsExpanded.forEach((tag) => tagCounts.set(tag, tagCounts.get(tag) - 1));
      item.tagsExpanded.forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1));
    }
    item.tagsVisibleExpanded = item.tagsVisible;
    item.tagsVisible.forEach((tag) => {
      item.tagsVisibleExpanded = item.tagsVisibleExpanded.concat(tagPrefixes(tag));
    });

    if (update_deps) {
      const prevDeps = item.deps || [];
      const prevDependents = item.dependents || [];
      item.deps = itemDeps(index);
      // console.debug("updated dependencies:", item.deps);

      const prevDeepHash = item.deephash;
      item.deephash = hashCode(
        item.deps
          .map((id) => items[indexFromId.get(id)].hash)
          .concat(item.hash)
          .join(",")
      );
      if (item.deephash != prevDeepHash && !item.log) item.time = Date.now();

      // update deps and deephash as needed for all dependent items
      // NOTE: we reconstruct dependents from scratch as needed for new items; we could scan only the dependents array once it exists and label has not changed, but we keep it simple and always do a full scan for now
      if (!item.dependents || item.label != prevLabel || item.deephash != prevDeepHash) {
        item.dependents = [];
        items.forEach((depitem, depindex) => {
          if (depindex == index) return; // skip self
          // NOTE: we only need to update dependencies on first update_deps or if item label has changed
          if (item.label != prevLabel) depitem.deps = itemDeps(depindex);
          if (item.label != prevLabel || (depitem.deps.includes(item.id) && item.deephash != prevDeepHash)) {
            // NOTE: changes to deephash trigger re-rendering and cache invalidation
            depitem.deephash = hashCode(
              depitem.deps
                .map((id) => items[indexFromId.get(id)].hash)
                .concat(depitem.hash)
                .join(",")
            );
          }
          if (depitem.deps.includes(item.id)) item.dependents.push(depitem.id);
        });
        // console.debug("updated dependents:", item.dependents);
      }

      // update deps/dependents strings
      item.depsString = itemDepsString(item);
      item.dependentsString = itemDependentsString(item);
      _.uniq(item.deps.concat(prevDeps)).forEach((id) => {
        const dep = items[indexFromId.get(id)];
        if (item.deps.includes(dep.id) && !dep.dependents.includes(item.id)) dep.dependents.push(item.id);
        else if (!item.deps.includes(dep.id) && dep.dependents.includes(item.id))
          dep.dependents = dep.dependents.filter((id) => id != item.id);
        dep.dependentsString = itemDependentsString(dep);
        // console.debug("updated dependentsString:", dep.dependentsString);
      });
      _.uniq(item.dependents.concat(prevDependents)).forEach((id) => {
        const dep = items[indexFromId.get(id)];
        dep.depsString = itemDepsString(dep);
      });
    }
  }

  // NOTE: secret phrase is initialized OR retrieved only ONCE PER SESSION so that it can not be tampered with after having been used to decrypt existing items; otherwise account can contain items encrypted using different secret phrases, which would make the account unusable
  let secret; // retrieved once and stored separately to prevent tampering during session

  import { tick } from "svelte";
  async function getSecretPhrase(new_phrase: boolean = false) {
    if (anonymous) throw Error("anonymous user can not have a secret phrase");
    if (secret) return secret; // already initialized from localStorage
    secret = localStorage.getItem("mindpage_secret");
    if (secret) return secret; // retrieved from localStorage
    await tick(); // wait until modal is rendered on page

    let phrase = "";
    let confirmed = "";
    if (new_phrase) {
      while (phrase == "" || confirmed != phrase) {
        while (phrase == "") {
          phrase = await modal.show({
            content:
              "Choose a <b>secret phrase</b> to encrypt your items so that they are readable <b>only by you, on your devices</b>. This phrase is never sent or stored anywhere (unless you save it somewhere such as a password manager) and should never be shared with anyone.",
            confirm: "Continue",
            cancel: "Sign Out",
            input: "",
          });
        }
        if (phrase == null) break;
        confirmed = await modal.show({
          content: "Confirm your new secret phrase:",
          confirm: "Confirm",
          cancel: "Sign Out",
          input: "",
        });
        if (confirmed == null) break;
        if (confirmed != phrase) {
          await modal.show({
            content: "Confirmed phrase did not match. Let's try again ...",
            confirm: "Try Again",
            background: "confirm",
          });
          phrase = "";
        }
      }
    } else {
      phrase = await modal.show({
        content: "Enter your secret phrase:",
        confirm: "Continue",
        cancel: "Sign Out",
        input: "",
      });
    }
    if (phrase == null || confirmed == null) throw new Error("secret phrase cancelled");
    const secret_utf8 = new TextEncoder().encode(user.uid + phrase);
    const secret_buffer = await crypto.subtle.digest("SHA-256", secret_utf8);
    const secret_array = Array.from(new Uint8Array(secret_buffer));
    const secret_string = secret_array.map((b) => String.fromCharCode(b)).join("");
    secret = btoa(secret_string);
    localStorage.setItem("mindpage_secret", secret);
    return secret;
  }

  // based on https://gist.github.com/chrisveness/43bcda93af9f646d083fad678071b90a
  async function encrypt(text: string) {
    if (!secret) secret = getSecretPhrase(true /* new_phrase */);
    secret = await Promise.resolve(secret); // resolve secret if promise pending
    const secret_utf8 = new TextEncoder().encode(secret); // utf8-encode secret
    const secret_sha256 = await crypto.subtle.digest("SHA-256", secret_utf8); // sha256-hash the secret
    const iv = crypto.getRandomValues(new Uint8Array(12)); // get 96-bit random iv
    const alg = { name: "AES-GCM", iv: iv }; // configure AES-GCM
    const key = await crypto.subtle.importKey("raw", secret_sha256, alg, false, ["encrypt"]); // generate key
    const text_utf8 = new TextEncoder().encode(text); // utf8-encode text
    const cipher_buffer = await crypto.subtle.encrypt(alg, key, text_utf8); // encrypt text using key
    const cipher_array = Array.from(new Uint8Array(cipher_buffer)); // convert cipher to byte array
    const cipher_string = cipher_array.map((byte) => String.fromCharCode(byte)).join(""); // convert cipher to string
    const cipher_base64 = btoa(cipher_string); // base64-encode cipher
    const iv_hex = Array.from(iv)
      .map((b) => ("00" + b.toString(16)).slice(-2))
      .join(""); // convert iv to hex string
    return iv_hex + cipher_base64; // return iv + cipher
  }

  async function decrypt(cipher: string) {
    if (!secret) secret = getSecretPhrase();
    secret = await Promise.resolve(secret); // resolve secret if promise pending
    const secret_utf8 = new TextEncoder().encode(secret); // utf8-encode secret
    const secret_sha256 = await crypto.subtle.digest("SHA-256", secret_utf8); // sha256-hash the secret
    const iv = cipher
      .slice(0, 24)
      .match(/.{2}/g)
      .map((byte) => parseInt(byte, 16)); // get iv from cipher
    const alg = { name: "AES-GCM", iv: new Uint8Array(iv) }; // configure AES-GCM
    const key = await crypto.subtle.importKey("raw", secret_sha256, alg, false, ["decrypt"]); // generate key
    const cipher_string = atob(cipher.slice(24)); // base64-decode cipher
    const cipher_array = new Uint8Array(cipher_string.match(/[\s\S]/g).map((ch) => ch.charCodeAt(0))); // convert cipher to byte array
    const text_buffer = await crypto.subtle.decrypt(alg, key, cipher_array); // decrypt cipher using key
    const text = new TextDecoder().decode(text_buffer); // utf8-decode text
    return text;
  }
  async function encryptItem(item) {
    if (anonymous) return item; // do not encrypt for anonymous user
    if (item.cipher) return item; // already encrypted
    if (!item.text) return item; // nothing to encrypt
    item.cipher = await encrypt(JSON.stringify(item));
    delete item.text; // remove text until decryption
    return item;
  }
  async function decryptItem(item) {
    if (item.text) return item; // already decrypted
    if (!item.cipher) return item; // nothing to decrypt
    item.text = JSON.parse(await decrypt(item.cipher)).text;
    delete item.cipher; // remove cipher until encryption
    return item;
  }

  let sessionCounter = 0; // to ensure unique increasing temporary ids for this session
  let sessionHistory = [];
  let sessionHistoryIndex = 0;
  let tempIdFromSavedId = new Map<string, string>();
  let editorText = "";
  function onEditorDone(text: string, e: any = null, cancelled: boolean = false, run: boolean = false, editing = null) {
    const key = e?.code || e?.key;
    if (cancelled) {
      if (key == "Escape") {
        setTimeout(() => textArea(-1).blur()); // requires dispatch on chrome
      } else {
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange((editorText = ""));
      }
      return;
    }

    // reset history index, update entry 0 and unshift duplicate entry
    // NOTE: we do not depend on onEditorChange keeping entry 0 updated, even though it should
    if (e) {
      // otherwise it is a "synthetic" call that is not added to history
      sessionHistoryIndex = 0;
      if (sessionHistory[0] != text.trim())
        if (sessionHistory.length == 0) sessionHistory = [text.trim()];
        else sessionHistory[0] = text.trim();
      sessionHistory.unshift(sessionHistory[0]);
    }

    let origText = text; // if text is modified, caret position will be lost
    let time = Date.now(); // default time is current, can be past if undeleting
    let clearLabel = false; // force clear, even if text starts with tag
    if (editing == null) {
      // NOTE: for non-synthetic calls, default is to edit unless any 2+ modifiers are held
      //       (some modifier combinations, e.g. Ctrl+Alt, may be blocked by browsers)
      editing = e && (e.metaKey ? 1 : 0) + (e.ctrlKey ? 1 : 0) + (e.altKey ? 1 : 0) < 2;
    }
    // disable running if Shift is held
    if (e && e.shiftKey) run = false;

    switch (text.trim()) {
      case "/_signout": {
        if (!signedin) {
          alert("already signed out");
          return;
        }
        signOut();
        return;
      }
      case "/_signin": {
        if (signedin) {
          alert("already signed in");
          return;
        }
        signIn();
        return;
      }
      case "/_count": {
        text = `${editingItems.length} items are selected`;
        break;
      }
      case "/_times": {
        if (editingItems.length == 0) {
          alert("/times: no item selected");
          return;
        }
        let item = items[editingItems[0]];
        text = `${new Date(item.time)}\n${new Date(item.updateTime)}\n${new Date(item.createTime)}`;
        break;
      }
      case "/_dependencies": {
        if (editingItems.length == 0) {
          alert("/_dependencies: no item selected");
          return;
        }
        if (editingItems.length > 1) {
          alert("/_dependencies: too many items selected");
          return;
        }
        text = items[editingItems[0]].depsString;
        clearLabel = true;
        break;
      }
      case "/_dependents": {
        if (editingItems.length == 0) {
          alert("/_dependents: no item selected");
          return;
        }
        if (editingItems.length > 1) {
          alert("/_dependents: too many items selected");
          return;
        }
        text = items[editingItems[0]].dependentsString;
        clearLabel = true;
        break;
      }
      case "/_backup": {
        if (readonly) return;
        let added = 0;
        items.forEach((item) => {
          firestore()
            .collection("history")
            .add({
              item: item.id,
              user: user.uid,
              time: item.time,
              text: item.text,
            })
            .then((doc) => {
              console.debug(`"added ${++added} of ${items.length} items to history`);
            })
            .catch(console.error);
        });
        return;
      }
      case "/_welcome": {
        firestore()
          .collection("items")
          .doc("QbtH06q6y6GY4ONPzq8N")
          .get()
          .then((doc) => {
            // _item("#Welcome").write(doc.data().text, "" /*whole item*/);
            onEditorDone(doc.data().text);
          })
          .catch(console.error);
        // text = "#Welcome";
        // editing = false;
        // break;
        return;
      }
      case "/_tweet": {
        if (editingItems.length == 0) {
          alert("/_tweet: no item selected");
          return;
        }
        if (editingItems.length > 1) {
          alert("/_tweet: too many items selected");
          return;
        }
        let item = items[editingItems[0]];
        location.href = "twitter://post?message=" + encodeURIComponent(item.text);
        return;
      }
      case "/_duplicate": {
        if (editingItems.length == 0) {
          alert("/_duplicate: no item selected");
          return;
        }
        if (editingItems.length > 1) {
          alert("/_duplicate: too many items selected");
          return;
        }
        let item = items[editingItems[0]];
        time = item.time;
        text = item.text;
        editing = true;
        break;
      }
      case "/_undelete": {
        if (deletedItems.length == 0) {
          alert("/_undelete: nothing to undelete (in this session)");
          return;
        }
        time = deletedItems[0].time;
        text = deletedItems[0].text;
        deletedItems.shift();
        editing = false;
        break;
      }
      case "/_invert": {
        inverted = !inverted;
        localStorage.setItem("mindpage_inverted", inverted ? "true" : "false");
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange((editorText = ""));
        return;
      }
      default: {
        if (text.match(/^\/\w+/)) {
          const cmd = text.match(/^\/\w+/)[0];
          const args = text
            .replace(/^\/\w+/, "")
            .trim()
            .replace(/`/g, "\\`");
          if (cmd == "/_example") {
            firestore()
              .collection("items")
              .where("user", "==", "anonymous")
              .orderBy("time", "desc")
              .get()
              .then((examples) => {
                alert(`retrieved ${examples.docs.length} example items`);
              })
              .catch(console.error);
            return;
          } else if (_item("#commands" + cmd)) {
            function handleError(e) {
              const log = _item("#commands" + cmd).console_log(-1 /*lastEvalTime*/, 4 /*errors*/);
              let msg = [`#commands${cmd} run(\`${args}\`) failed:`, ...log, e].join("\n");
              alert(msg);
            }
            try {
              // NOTE: if command item is async (or has async dependents), we specify async:true for eval so that it provides (given "command" trigger) a light-weight async wrapper that does not output/log into the item
              let cmd_item = items[_item("#commands" + cmd).index];
              const async =
                cmd_item.async || cmd_item.deps.map((id) => items[indexFromId.get(id)].async).includes(true);
              Promise.resolve(
                _item("#commands" + cmd).eval((async ? "return " : "") + `run(\`${args}\`)`, {
                  trigger: "command",
                  async, // enables async command wrapper
                })
              )
                .then((obj) => {
                  if (!obj) {
                    onEditorChange((editorText = ""));
                  } else if (typeof obj == "string") {
                    onEditorChange((editorText = obj));
                    textArea(-1).focus(); // refocus on non-empty editor
                  } else if (typeof obj != "object" || !obj.text || typeof obj.text != "string") {
                    alert(
                      `#commands${cmd}: run(\`${args}\`) returned invalid value; must be of the form {text:"...", edit:true|false, run:true|false}`
                    );
                  } else {
                    text = obj.text;
                    // if obj.{edit,run} is not truthy or falsy we keep the default (based on modifier keys)
                    if (obj.edit == true) editing = true;
                    else if (obj.edit == false) editing = false;
                    if (obj.run == true) run = true;
                    else if (obj.run == false) run = false;
                    // since we are async, we need to call onEditorDone again with run/editing set properly
                    let item = onEditorDone((editorText = text), null, false, run, editing);
                    // run programmatic initializer function if any
                    try {
                      if (obj.init) Promise.resolve(obj.init(item)).catch(handleError);
                    } catch (e) {
                      handleError(e);
                      throw e;
                    }
                  }
                })
                .catch(handleError);
            } catch (e) {
              handleError(e);
              throw e;
            }
            return;
          } else {
            alert(`unknown command ${cmd}`);
            return;
          }
        } else if (text.match(/^\/\s+/s)) {
          // clear /(space) as a mechanism to disable search
          // (onEditorChange already ignores text starting with /)
          // text = text.replace(/^\/\s+/s, "");
        }
        // editing = text.trim().length == 0; // if text is empty, continue editing
      }
    }

    let itemToSave = {
      user: user.uid,
      time: time,
      text: text,
    };
    let item = {
      ...itemToSave,
      id: (Date.now() + sessionCounter++).toString(), // temporary id for this session only
      savedId: null, // filled in below after save
      editing: editing,
      saving: !editing,
      savedTime: time,
      savedText: "", // so cancel = delete
    };
    items = [item, ...items];

    // update indices as needed by itemTextChanged
    indexFromId = new Map<string, number>();
    items.forEach((item, index) => indexFromId.set(item.id, index));
    itemTextChanged(0, text);

    // if text is not synthetic and starts with a tag, keep if non-unique label
    // (useful for adding labeled items, e.g. todo items, without losing context)
    editorText =
      e /* e == null for synthetic calls, e.g. from commands */ &&
      !clearLabel &&
      items[0].label &&
      !items[0].labelUnique &&
      items[0].labelText &&
      editorText.startsWith(items[0].labelText + " ")
        ? items[0].labelText + " "
        : "";

    lastEditorChangeTime = 0; // disable debounce even if editor focused
    onEditorChange(editorText); // integrate new item at index 0

    if (run) {
      // NOTE: appendJSOutput can trigger _writes that trigger saveItem, which will be skip due to saveId being null
      appendJSOutput(indexFromId.get(item.id));
      text = itemToSave.text = item.text; // no need to update editorText
    }

    let textarea = textArea(-1);
    textarea.focus(); // refocus (necessary on iOS for shifting focus to another item)
    if (editing) {
      let selectionStart = textarea.selectionStart;
      let selectionEnd = textarea.selectionEnd;
      // for generated (vs typed) items, focus at the start for better context and no scrolling up
      // if (text != origText) selectionStart = selectionEnd = text.length;
      if (text != origText) selectionStart = selectionEnd = 0;
      setTimeout(() => {
        let textarea = textArea(indexFromId.get(item.id));
        textarea.selectionStart = selectionStart;
        textarea.selectionEnd = selectionEnd;
        textarea.focus();
      }, 0);
    }

    encryptItem(itemToSave).then((itemToSave) => {
      (readonly
        ? Promise.resolve({ id: item.id, delete: Promise.resolve })
        : firestore().collection("items").add(itemToSave)
      )
        .then((doc) => {
          let index = indexFromId.get(item.id); // since index can change
          tempIdFromSavedId.set(doc.id, item.id);
          item = items[index];
          if (index == undefined) {
            // item was deleted before it could be saved
            doc.delete().catch(console.error);
            return;
          }
          let textarea = textArea(index);
          let selectionStart = textarea ? textarea.selectionStart : 0;
          let selectionEnd = textarea ? textarea.selectionEnd : 0;
          item.savedId = doc.id;
          // if editing, we do not call onItemSaved so save is postponed to post-edit, and cancel = delete
          if (!item.editing) onItemSaved(item.id, itemToSave);
          else items[index] = item; // trigger dom update

          if (focusedItem == index)
            // maintain focus (and caret placement) through id/element change
            setTimeout(() => {
              let index = indexFromId.get(item.id);
              if (index == undefined) return;
              let textarea = textArea(index);
              if (!textarea) return;
              textarea.selectionStart = selectionStart;
              textarea.selectionEnd = selectionEnd;
              textarea.focus();
            }, 0);
          // also save to history (using persistent doc.id) ...
          if (!readonly) {
            firestore()
              .collection("history")
              .add({ item: doc.id, ...itemToSave })
              .catch(console.error);
          }
        })
        .catch(console.error);
    }); // encryptItem(itemToSave)

    return _item(item.id); // return reference to created item
  }

  function focusOnNearestEditingItem(index: number) {
    // console.debug("focusOnNearestEditingItem", index, editingItems);
    let near = Math.min(...editingItems.filter((i) => i > index && i < hideIndex));
    if (near == Infinity) near = Math.max(...[-1, ...editingItems.filter((i) => i < hideIndex)]);
    focusedItem = near;
    // if (near == -1) return; // do not auto-focus on editor
    setTimeout(() => {
      textArea(near).focus();
      // console.debug("focused on item", near);
    }, 0);
  }

  function onItemSaved(id: string, savedItem) {
    const index = indexFromId.get(id);
    if (index == undefined) return; // item was deleted
    // console.debug("saved item", index);
    let item = items[index];

    decryptItem(savedItem).then((savedItem) => {
      item.savedText = savedItem.text;
      item.savedTime = savedItem.time;
      item.saving = false;
      items[index] = item; // trigger dom update
      if (item.saveClosure) {
        item.saveClosure(item.id);
        delete item.saveClosure;
      }
    }); // decryptItem(savedItem)
  }

  let lastEditTime = 0; // updated in onItemEdited
  let layoutPending = false;
  function onItemResized(id, container, trigger: string) {
    if (!container) return;
    const index = indexFromId.get(id);
    if (index == undefined) return;
    let item = items[index];
    // exclude any ._log elements since they are usually collapsed
    let logHeight = 0;
    container.querySelectorAll("._log").forEach((log) => (logHeight += log.offsetHeight));
    const height = container.offsetHeight - logHeight;
    const prevHeight = item.height;
    if (height == prevHeight) return; // nothing has changed
    // NOTE: on iOS, editing items can trigger zero height to be reported, which we ignore
    //       (seems to make sense generally since items should not have zero height)
    if (height == 0 && prevHeight > 0) {
      // console.warn(
      //   `zero height (last known height ${prevHeight}) for item ${id} at index ${index+1}`,
      //   item.text.substring(0, Math.min(item.text.length, 80))
      // );
      return;
    }

    // console.debug(
    //   `[${index + 1}] ${
    //     item.label ? item.label + ": " : ""
    //   } height changed ${prevHeight} → ${height} (${trigger})`
    // );
    item.height = height;

    // NOTE: Heights can fluctuate due to async scripts that generate div contents (e.g. charts), especially where the height of the output is not known and can not be specified via CSS, e.g. as an inline style on the div. We tolerate these changes for now, but if this becomes problematic we can skip or delay some layout updates, especially when the height is decreasing, postponing layout update to other events, e.g. reordering of items.
    if (
      height == 0 ||
      prevHeight == 0 ||
      height != prevHeight
      // height < 0.5 * prevHeight ||
      // height > prevHeight + 100
    ) {
      if (!layoutPending) {
        layoutPending = true;
        const layoutInterval = setInterval(
          () => {
            // TODO: if this does not prevent the edit issues, consider waiting until no item editor has focus
            // (also make sure it is related to item resizing, because sometimes it seems to happen w/o resizing and in that case would be more related to keyboard event handling in Editor)
            if (Date.now() - lastEditTime >= 500) {
              updateItemLayout();
              layoutPending = false;
              clearInterval(layoutInterval);
            }
          },
          // if totalItemHeight == 0, then we have not yet done any layout with item heights available, so we do not want to delay too long, but just want to give it enough time for heights to be reasonably accurate
          totalItemHeight > 0 ? 250 : 50
        );
      }
    }
  }

  function itemShowLogs(id: string, autohide_after: number = 15000) {
    let index = indexFromId.get(id);
    if (index == undefined) return;
    items[index].showLogs = true;
    const dispatchTime = (items[index].showLogsTime = Date.now());
    if (autohide_after > 0) {
      setTimeout(() => {
        let index = indexFromId.get(id);
        if (index == undefined) return;
        if (dispatchTime == items[index].showLogsTime) items[index].showLogs = false;
      }, autohide_after);
    }
  }

  function removeBlock(text: string, type: string) {
    return text.replace(blockRegExp(type), "");
  }

  function clearBlock(text: string, type: string) {
    return text.replace(blockRegExp(type), (m, pfx, t) => pfx + "```" + t + "\n```");
  }

  function appendBlock(text: string, type: string, block) {
    if (typeof block != "string") block = "" + block;
    if (block.length > 0 && block[block.length - 1] != "\n") block += "\n";
    const regex = blockRegExp(type);
    let count = 0;
    text = text.replace(regex, (m, pfx, t) => pfx + "```" + t + "\n" + (count++ == 0 ? block : "") + "```");
    if (count == 0) text = [text, "```" + type + "\n" + block + "```"].join("\n");
    return text;
  }

  function appendJSOutput(index: number): string {
    let item = items[index];
    // check js_input, must mention 'done' if async mode
    const async = item.async || item.deps.map((id) => items[indexFromId.get(id)].async).includes(true);
    let jsin = extractBlock(item.text, "js_input");
    if (!jsin) return item.text; // missing or empty, ignore
    let jsout = _item(item.id).eval(jsin, { debug: item.debug, async, trigger: "run" /*|create*/ });
    // ignore output if Promise
    if (jsout instanceof Promise) jsout = undefined;
    const outputConfirmLength = 16 * 1024;
    if (jsout && jsout.length >= outputConfirmLength) {
      if (!confirm(`Write ${jsout.length} bytes (_output) into ${item.name}?`)) jsout = undefined;
    }
    // append _output and _log and update for changes
    if (jsout) item.text = appendBlock(item.text, "_output", jsout);
    _item(item.id).write_log(); // auto-write log
    // NOTE: index can change during JS eval due to _writes
    itemTextChanged(indexFromId.get(item.id), item.text);
    return item.text;
  }

  function saveItem(id: string) {
    // console.debug("saving item", id);
    const index = indexFromId.get(id);
    if (index == undefined) return; // item deleted
    let item = items[index];
    // if item is already saving, set saveClosure and return (no need to chain)
    if (item.saving) {
      item.saveClosure = saveItem;
      return;
    }
    if (!item.savedId) {
      // NOTE: this can happen due to appendJSOutput for new item on onEditorDone()
      // console.error("item is not being saved but also does not have its permanent id");
      return;
    }
    item.saving = true;
    let itemToSave = {
      user: user.uid, // allows us to use set() instead of update()
      time: item.time,
      text: item.text,
    };

    if (readonly) {
      setTimeout(() => onItemSaved(item.id, itemToSave));
      return;
    }

    encryptItem(itemToSave).then((itemToSave) => {
      firestore()
        .collection("items")
        .doc(item.savedId)
        .set(itemToSave)
        .then(() => {
          onItemSaved(item.id, itemToSave);
        })
        .catch(console.error);

      // also save to history ...
      firestore()
        .collection("history")
        .add({ item: item.savedId, ...itemToSave })
        .catch(console.error);
    }); // encryptItem(itemToSave)
  }

  // https://stackoverflow.com/a/9039885
  function iOS() {
    return (
      ["iPad Simulator", "iPhone Simulator", "iPod Simulator", "iPad", "iPhone", "iPod"].includes(navigator.platform) ||
      // iPad on iOS 13 detection
      (navigator.userAgent.includes("Mac") && "ontouchend" in document)
    );
  }
  // https://stackoverflow.com/a/6031480
  function android() {
    return navigator.userAgent.toLowerCase().includes("android");
  }

  function onItemEditing(index: number, editing: boolean, cancelled: boolean = false, run: boolean = false) {
    // console.debug(`item ${index} editing: ${editing}, editingItems:${editingItems}, focusedItem:${focusedItem}`);
    let item = items[index];

    // update time for non-log item
    if (!item.log) item.time = Date.now();

    // if cancelled, restore savedText
    // NOTE: we do not restore time so item remains "soft touched"
    if (cancelled) {
      // item.time = item.savedTime;
      item.text = item.savedText;
    }

    if (editing) {
      // started editing
      editingItems.push(index);
      lastEditorChangeTime = 0; // disable debounce even if editor focused
      onEditorChange(editorText); // editing state (and possibly time) has changed
      // NOTE: setTimeout is required for editor to be added to the Dom
      if (iOS()) {
        textArea(-1).focus(); // temporary, allows focus to be set ("shifted") within setTimout, outside click event
        // See https://stackoverflow.com/questions/12204571/mobile-safari-javascript-focus-method-on-inputfield-only-works-with-click.
      }
      setTimeout(() => {
        textArea(item.index).focus();
      }, 0); // trigger resort
    } else {
      // stopped editing
      editingItems.splice(editingItems.indexOf(index), 1);
      // NOTE: onItemFocused may not get invoked (and item.focused may remain true) on destroyed editors
      if (focusedItem == index) {
        focusedItem = -1;
        item.focused = false;
      }
      if (item.text.trim().length == 0) {
        // delete
        itemTextChanged(index, ""); // clears label, deps, etc
        items.splice(index, 1);
        // update indices as needed by onEditorChange
        indexFromId = new Map<string, number>();
        items.forEach((item, index) => indexFromId.set(item.id, index));
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange(editorText); // deletion can affect ordering (e.g. due to missingTags)
        deletedItems.unshift({
          time: item.savedTime,
          text: item.savedText,
        }); // for /undelete
        if (!readonly && item.savedId) {
          firestore().collection("items").doc(item.savedId).delete().catch(console.error);
        }
      } else {
        itemTextChanged(index, item.text);
        // clear _output and execute javascript unless cancelled
        if (run && !cancelled) {
          // clear *_output blocks as they should be re-generated
          item.text = clearBlock(item.text, "\\w*?_output");
          // remove *_log blocks so errors do not leave empty blocks
          item.text = removeBlock(item.text, "\\w*?_log");
          itemTextChanged(index, item.text); // updates tags, label, deps, etc before JS eval
          appendJSOutput(index);
        }
        // save edit state for resuming edit
        if (!cancelled) {
          let textarea = textArea(item.index);
          lastEditItem = item.id;
          lastEditSelectionStart = textarea.selectionStart;
          lastEditSelectionEnd = textarea.selectionEnd;
        }
        if (!cancelled && (item.time != item.savedTime || item.text != item.savedText)) saveItem(item.id);
        onEditorChange(editorText); // item time and/or text may have changed
      }

      // NOTE: we do not focus back up on the editor unless we are already at the top
      //       (especially bad on iphone due to lack of keyboard focus benefit)
      if (editingItems.length > 0 || window.scrollY == 0) {
        focusOnNearestEditingItem(index);
      } else {
        // scroll up if needed, allowing dom update before calculating new position
        // (particularly important for items that are much taller when editing)
        setTimeout(() => {
          const div = document.querySelector("#super-container-" + item.id);
          if (!div) return; // item deleted or hidden
          const itemTop = (div as HTMLElement).offsetTop;
          if (itemTop < window.scrollY) {
            // console.debug("scrolling up", itemTop, window.scrollY);
            window.top.scrollTo(0, itemTop);
          }
        });
      }
    }
  }

  // WARNING: onItemFocused may NOT be invoked when editor is destroyed
  function onItemFocused(index: number, focused: boolean) {
    if (focused) focusedItem = index;
    else focusedItem = -1;
    // console.debug(
    //   `item ${index} focused: ${focused}, focusedItem:${focusedItem}`
    // );
  }

  function onItemEdited(index: number, text: string) {
    lastEditTime = Date.now();
  }

  function onItemRun(index: number = -1) {
    if (index < 0) index = focusedItem;
    let item = items[index];
    // clear *_output blocks as they should be re-generated
    item.text = clearBlock(item.text, "\\w*?_output");
    // remove *_log blocks so errors do not leave empty blocks
    item.text = removeBlock(item.text, "\\w*?_log");
    itemTextChanged(index, item.text); // updates tags, label, deps, etc before JS eval
    appendJSOutput(index);
    item.time = Date.now();
    if (!item.editing) saveItem(item.id);
    lastEditorChangeTime = 0; // force immediate update (editor should not be focused but just in case)
    onEditorChange(editorText); // item time/text has changed
  }

  function onItemTouch(index: number) {
    if (items[index].log) {
      alert("#log item can not be moved");
      return;
    } // ignore
    if (items[index].time > newestTime) console.warn("invalid item time");
    if (altKey && metaKey) {
      // move item time back 1 day
      items[index].time = items[index].time - 24 * 3600 * 1000;
    } else if (altKey) {
      if (index == items.length - 1 || items[index].time < items[index + 1].time) {
        alert("can not move item down");
        return;
      }
      items[index].time = items[index + 1].time - 1;
    } else if (metaKey) {
      if (index == 0 || items[index].time > items[index - 1].time) {
        alert("can not move item up");
        return;
      }
      items[index].time = items[index - 1].time + 1;
    } else {
      items[index].time = Date.now();
    }
    saveItem(items[index].id);
    lastEditorChangeTime = 0; // force immediate update (editor should not be focused but just in case)
    onEditorChange(editorText); // item time has changed
    // onEditorChange((editorText = "")); // item time has changed, and editor cleared
  }

  function editItem(index: number) {
    items[index].editing = true;
    editingItems.push(index);
  }

  let lastEditItem;
  let lastEditSelectionStart;
  let lastEditSelectionEnd;
  function resumeLastEdit() {
    if (!lastEditItem) return;
    let index = indexFromId.get(lastEditItem);
    if (index == undefined) return;
    if (index >= hideIndex) return;
    if (items[index].editing) return;
    editItem(index);
    lastEditorChangeTime = 0; // force immediate update
    onEditorChange(editorText); // since edit state changed
    setTimeout(() => {
      let index = indexFromId.get(lastEditItem);
      if (index == undefined) return;
      textArea(index).focus();
      textArea(index).selectionStart = lastEditSelectionStart;
      textArea(index).selectionEnd = lastEditSelectionEnd;
    });
  }

  function textArea(index: number): HTMLTextAreaElement {
    return document.getElementById("textarea-" + (index < 0 ? "mindbox" : items[index].id)) as HTMLTextAreaElement;
  }

  function onPrevItem(inc = -1) {
    if (sessionHistoryIndex > 0 || focusedItem + inc < -1) {
      if (sessionHistoryIndex + 1 < sessionHistory.length) {
        sessionHistoryIndex++;
        // console.debug("sessionHistoryIndex", sessionHistoryIndex);
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange((editorText = sessionHistory[sessionHistoryIndex]));
        setTimeout(() => {
          textArea(-1).selectionStart = textArea(-1).selectionEnd = editorText.length;
        });
      }
      return;
    }
    const index = focusedItem;
    if (index + inc == -1) textArea(-1).focus();
    else {
      if (!items[index + inc].editing) {
        if (items[index + inc].pinned) {
          onPrevItem(inc - 1);
          return;
        } // skip if pinned
        editItem(index + inc);
      }
      setTimeout(() => textArea(index + inc).focus(), 0);
    }
  }

  function onNextItem(inc = 1) {
    if (sessionHistoryIndex > 0) {
      sessionHistoryIndex--;
      // console.debug("sessionHistoryIndex", sessionHistoryIndex);
      lastEditorChangeTime = 0; // disable debounce even if editor focused
      onEditorChange((editorText = sessionHistory[sessionHistoryIndex]));
      setTimeout(() => {
        const endOfFirstLine = editorText.match(/^[^\n]*/)[0].length;
        textArea(-1).selectionStart = textArea(-1).selectionEnd = endOfFirstLine;
      });
      return;
    }
    if (focusedItem + inc >= Math.min(hideIndex, items.length)) return;
    const index = focusedItem;
    if (!items[index + inc].editing) {
      if (items[index + inc].pinned || items[index + inc].saving || items[index + inc].running) {
        onNextItem(inc + 1);
        return;
      } // skip if pinned, saving, or running
      editItem(index + inc);
    }
    setTimeout(() => textArea(index + inc).focus(), 0);
  }

  function updateDotted() {
    if (!consolediv) return; // can happen during login process
    // auto-hide dotted items (and console) when empty
    if (dotCount == 0) showDotted = false;
    // force show dotted items when any of them are editing
    if (editingItems.findIndex((i) => items[i].dotted) >= 0) showDotted = true;
    (document.querySelector("span.dots") as HTMLElement).style.opacity = "1";
    (document.querySelector("span.dots") as HTMLElement).style.display = showDotted ? "none" : "block";
    (document.querySelector("span.triangle") as HTMLElement).style.display = showDotted ? "block" : "none";
    document.querySelectorAll(".dotted").forEach((dotted) => {
      (dotted as HTMLElement).style.display = showDotted ? "block" : "none";
    });
  }

  let lastScrollTime = 0;
  let showDotted = false;
  function onScroll() {
    lastScrollTime = Date.now();
    return;
  }

  function onStatusClick(e) {
    // ignore click if text is selected
    if (window.getSelection().type == "Range") {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    showDotted = !showDotted;
    updateDotted();
  }

  function onConsoleClick(e) {
    // ignore click if text is selected
    if (window.getSelection().type == "Range") {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    consolediv.style.display = "none";
    document.getElementById("console-summary").style.visibility = "visible";
  }
  function onConsoleSummaryClick(e) {
    if (consolediv.childNodes.length > 0) {
      e.stopPropagation();
      consolediv.style.display = "block";
      document.getElementById("console-summary").style.visibility = "hidden";
    }
  }

  function errorMessage(e) {
    if (!e) return undefined;
    // Some client libraries (e.g. Google API JS client) return an embedded 'error' property, which can itself be a non-standard object with various details (e.g. HTTP error code, message, details, etc), so we just stringify the whole object to provide the most information possible.
    if (!e.message && e.error) return JSON.stringify(e);
    // NOTE: for UnhandledPromiseRejection, Event object is placed in e.reason
    // NOTE: we log url for "error" Events that do not have message/reason
    //       (see https://www.w3schools.com/jsref/event_onerror.asp)
    if (!e.message && (e.type == "error" || (e.reason && e.reason.type == "error"))) {
      if (e.reason) e = e.reason;
      let url = e.target && (e.target["url"] || e.target["src"]) ? e.target["url"] || e.target["src"] : "(unknown url)";
      return `error loading ${url}`;
    }
    return e.reason
      ? `Unhandled Rejection: ${e.reason} (line:${e.reason.line}, col:${e.reason.column})`
      : e.message
      ? e.lineno
        ? `${e.message} (line:${e.lineno}, col:${e.colno})`
        : e.line
        ? `${e.message} (line:${e.line}, col:${e.column})`
        : e.stack // all we seem to have is a trace, so let's dump that ...
        ? `${e.message}; STACK TRACE:\n${e.stack
            .split("\n")
            .map((s) => "ERROR: - " + s)
            .join("\n")}`
        : e.message
      : undefined;
  }

  function encryptionError(e) {
    console.error("encryption/decryption failed", e);
    if (signingOut) return; // already signing out
    signingOut = true; // no other option at this point
    if (e.message.includes("cancelled")) {
      signOut();
      return;
    }
    // dispatch in case error is triggered before modal is created
    modal.show({
      content:
        "Unable to access your account. Secret phrase may be incorrect, or your browser may not fully support modern encryption features. Try entering your phrase again or using a different browser. If the problem persists, email support@mind.page with your browser and device information. <i>Do not include your secret phrase, which you should never share with anyone.</i>",
      confirm: "Sign Out",
      background: "confirm",
      onConfirm: signOut,
    });
  }

  import { onMount } from "svelte";
  import {
    hashCode,
    numberWithCommas,
    extractBlock,
    blockRegExp,
    parseTags,
    renderTag,
    invalidateElemCache,
  } from "../util.js";

  let consoleLog = [];
  const consoleLogMaxSize = 10000;
  const statusLogExpiration = 15000;

  let itemInitTime = 0;
  function initItems() {
    if (itemInitTime) return; // already initialized items
    itemInitTime = Date.now();
    items.forEach((item) => {
      if (item.init) _item(item.id).eval("_init()", { include_deps: false, trigger: "init" });
    });
  }

  let initTime = 0;
  let adminItems = new Set(["QbtH06q6y6GY4ONPzq8N" /* welcome item */]);
  async function initialize() {
    // decrypt any encrypted items
    items = (await Promise.all(items.map(decryptItem)).catch(encryptionError)) || [];
    if (signingOut) return; // encryption error

    // filter hidden items on readonly account
    if (readonly) items = items.filter((item) => !adminItems.has(item.id));

    indexFromId = new Map<string, number>(); // needed for initial itemTextChanged
    items.forEach((item, index) => indexFromId.set(item.id, index));
    items.forEach((item, index) => {
      itemTextChanged(index, item.text, false); // deps handled below after index assignment
      item.admin = adminItems.has(item.id);
      item.savedId = item.id;
      item.savedText = item.text;
      item.savedTime = item.time;
      // NOTE: we also initialized other state here to have a central listing
      // state used in onEditorChange
      item.tagMatches = 0;
      item.labelMatch = false;
      item.prefixMatch = false;
      item.pinnedMatch = false;
      item.pinnedMatchTerm = "";
      item.uniqueLabel = "";
      // item.uniqueLabelPrefixes = [];
      item.matchingTerms = [];
      item.matchingTermsSecondary = [];
      item.missingTags = [];
      item.hasError = false;
      // state from updateItemLayout
      item.index = index;
      item.lastIndex = index;
      item.timeString = "";
      item.timeOutOfOrder = false;
      item.height = 0;
      item.column = 0;
      item.lastColumn = 0;
      item.nextColumn = -1;
      item.nextItemInColumn = -1;
      item.outerHeight = 0;
      // dependents (filled below)
      item.dependents = [];
      item.dependentsString = "";
      // other state
      item.lastEvalTime = 0; // used for _item.console_log
      item.lastRunTime = 0; // used for _item.console_log
    });
    onEditorChange(""); // initial sorting
    items.forEach((item, index) => {
      // initialize deps, deephash, missing tags/labels
      item.deps = itemDeps(index);
      item.deephash = hashCode(
        item.deps
          .map((id) => items[indexFromId.get(id)].hash)
          .concat(item.hash)
          .join()
      );
      item.deps.forEach((id) => items[indexFromId.get(id)].dependents.push(item.id));
    });
    items.forEach((item) => {
      item.depsString = itemDepsString(item);
      item.dependentsString = itemDependentsString(item);
    });
    setTimeout(initItems); // need to dispatch as it needs window._eval

    initTime = Math.round(performance.now());
    console.debug(`initialized ${items.length} items at ${initTime}ms`);

    // if fragment corresponds to an item tag or id, focus on that item immediately ...
    if (items.length > 0 && location.href.match(/#.+$/)) {
      const tag = decodeURI(location.href.match(/#.+$/)[0]);
      // if it is a valid item id, then we convert it to name
      const index = indexFromId.get(tag.substring(1));
      if (index != undefined) {
        replaceStateOnEditorChange = true; // replace state
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange((editorText = items[index].name));
      } else if (idsFromLabel.get(tag.toLowerCase())?.length == 1) {
        replaceStateOnEditorChange = true; // replace state
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange((editorText = tag));
      }
    }
  }

  let signingIn = false;
  function signIn() {
    if (firebase().auth().currentUser) return; // already signed in, must sign out first
    signingIn = true;

    // blur active element as caret can show through loading div
    // (can require dispatch on chrome if triggered from active element)
    setTimeout(() => (document.activeElement as HTMLElement).blur());

    resetUser();
    window.sessionStorage.setItem("mindpage_signin_pending", "1"); // prevents anonymous user on reload
    document.cookie = "__session=signin_pending;max-age=600"; // temporary setting for server post-redirect

    let provider = new window.firebase.auth.GoogleAuthProvider();
    firebase().auth().useDeviceLanguage();
    // firebase().auth().setPersistence("none")
    // firebase().auth().setPersistence("session")
    firebase().auth().setPersistence("local");
    // NOTE: Both redirect and popup-based login methods work in most cases. Android can fail to login with redirects (perhaps getRedirectResult could work better although should be redundant given onAuthStateChanged) but works ok with popup. iOS looks better with redirect, and firebase docs (https://firebase.google.com/docs/auth/web/google-signin) say redirect is preferred on mobile. Indeed popup feels better on desktop, even though it also requires a reload for now (much easier and cleaner than changing all user/item state). So we currently use popup login except on iOS, where we use a redirect for cleaner same-tab flow.
    // if (!android()) firebase().auth().signInWithRedirect(provider);
    if (iOS()) firebase().auth().signInWithRedirect(provider);
    else {
      firebase()
        .auth()
        .signInWithPopup(provider)
        .then(() => location.reload())
        .catch(console.error);
    }
  }

  function useAnonymousAccount() {
    console.log("using anonymous account");
    user = {
      photoURL: "/incognito.png",
      displayName: "Anonymous",
      uid: "anonymous",
    };
    secret = null; // should never be needed under anonymous account
    anonymous = true;
    // anonymous account should not have a server cookie (even if admin)
    document.cookie = "__session=;max-age=0";
  }

  if (isClient) {
    // redirect console.error to save errors until #console is set up in onMount
    let errors = [];
    console["_error"] = console.error;
    console.error = (...args) => errors.push(args);

    // NOTE: We simply log the server side error as a warning. Currently only possible error is "invalid session cookie" (see session.ts), and assuming items are not returned/initialized below, firebase realtime should be able to initialize items without requiring a page reload, which is why this can be just a warning.
    if (error) console.warn(error); // log server-side error

    // pre-fetch user from localStorage instead of waiting for onAuthStateChanged
    // (seems to be much faster to render user.photoURL, but watch out for possible 403 on user.photoURL)
    if (!user && localStorage.getItem("mindpage_user")) {
      user = JSON.parse(localStorage.getItem("mindpage_user"));
      secret = localStorage.getItem("mindpage_secret"); // may be null if user was acting as anonymous
      console.debug(`restored user ${user.email} from local storage`);
    } else if (window.sessionStorage.getItem("mindpage_signin_pending")) {
      console.debug("resuming signing in ...");
      window.sessionStorage.removeItem("mindpage_signin_pending"); // no longer considered pending
      user = secret = null;
    } else {
      useAnonymousAccount();
    }
    anonymous = user?.uid == "anonymous";
    readonly = anonymous && !admin();
    if (admin()) useAnonymousAccount(); // become anonymous for item checks

    // if items were returned from server, confirm user, then initialize if valid
    let initialization;
    if (items.length > 0) {
      if (window.sessionStorage.getItem("mindpage_signin_pending")) {
        console.warn(`ignoring ${items.length} items received while signing in`);
        items = [];
      } else if (user && user.uid != items[0].user) {
        // items are for wrong user, usually anonymous, due to missing cookie
        // (you can test this with document.cookie='__session=;max-age=0' in console)
        console.warn(`ignoring ${items.length} items received for wrong user (${items[0].user})`);
        items = [];
      } else {
        // NOTE: at this point item heights (and totalItemHeight) will be zero and the loading indicator stays, but we need the items on the page to compute their heights, which will trigger updated layout through onItemResized
        initialization = initialize();
      }
    }

    // NOTE: we do not attempt login for readonly account (if login hangs, this is suspect)
    if (!readonly) {
      // if initializing items, wait for that before signing in user since errors can trigger signout
      Promise.resolve(initialization).then(() => {
        firebase()
          .auth()
          .onAuthStateChanged((authUser) => {
            // console.debug("onAuthStateChanged", user, authUser);
            if (readonly) {
              console.warn("ignoring unexpected signin");
              return;
            }
            if (!authUser) {
              if (anonymous) return; // anonymous user can be signed in or out
              console.error("failed to sign in"); // can happen in chrome for localhost, and on android occasionally
              document.cookie = "__session=;max-age=0"; // delete cookie to prevent preload on reload
              return;
            }
            resetUser(); // clean up first
            user = authUser;
            console.log("signed in", user.email);
            localStorage.setItem("mindpage_user", JSON.stringify(user));
            anonymous = readonly = false; // just in case (should already be false)
            signedin = true;

            // NOTE: olcans@gmail.com signed in as "admin" will ACT as anonymous account
            //       (this is the only case where user != firebase().auth().currentUser)
            if (admin()) {
              useAnonymousAccount();
            } else {
              // set up server-side session cookie
              // store user's ID token as a 1-hour __session cookie to send to server for preload
              // NOTE: __session is the only cookie allowed by firebase for efficient caching
              //       (see https://stackoverflow.com/a/44935288)
              user
                .getIdToken(false /*force refresh*/)
                .then((token) => {
                  document.cookie = "__session=" + token + ";max-age=3600";
                })
                .catch(console.error);
            }

            initFirebaseRealtime();
          });
      });
    }

    // Visual viewport resize/scroll handlers ...
    // NOTE: we use document width because it is invariant to zoom scale but sensitive to font size
    //       (also window.outerWidth can be stale after device rotation in iOS Safari)
    let lastDocumentWidth = 0;
    function checkLayout() {
      if (Date.now() - lastScrollTime < 250) return; // will be invoked again via setInterval
      const documentWidth = document.documentElement.clientWidth;
      if (documentWidth != lastDocumentWidth) {
        // console.debug(
        //   `document width changed from ${lastDocumentWidth} to ${documentWidth}`
        // );
        updateItemLayout();
        // resize of all elements w/ _resize attribute (and property)
        document.querySelectorAll("[_resize]").forEach((elem) => elem["_resize"]());
        lastDocumentWidth = documentWidth;
        return;
      }
      // update time strings every 10 seconds
      // NOTE: we do NOT update time string visibility/grouping here, and there can be differences (from layout strings) in both directions (time string hidden while distinct from previous item, or time string shown while identical to previous item) but arguably we may not want to show/hide time strings (and shift items) outside of an actual layout, and time strings should be interpreted as rough (but correct) markers along the timeline, with items grouped between them in correct order and with increments within the same order of unit (m,h,d) implied by last shown time string
      if (Date.now() - lastTimeStringUpdateTime > 10000) {
        lastTimeStringUpdateTime = Date.now();
        items.forEach((item, index) => {
          if (!item.timeString) return;
          item.timeString = itemTimeString((Date.now() - item.time) / 1000);
        });
        items = items; // trigger svelte render
      }
    }
    visualViewport.addEventListener("resize", checkLayout);
    visualViewport.addEventListener("scroll", onScroll);

    let firstSnapshot = true;
    function initFirebaseRealtime() {
      if (!user || !firebase().auth().currentUser) return; // need user object and auth

      // start listening for remote changes
      // (also initialize if items were not returned by server)
      firebase()
        .firestore()
        .collection("items")
        .where("user", "==", user.uid)
        .orderBy("time", "desc")
        .onSnapshot(
          function (snapshot) {
            if (firstSnapshot) {
              // console.debug(
              //   `onSnapshot invoked at ${Math.round(
              //     window.performance.now()
              //   )}ms w/ ${items.length} items`
              // );
              setTimeout(async () => {
                console.debug(`${items.length} items synchronized at ${Math.round(performance.now())}ms`);
                if (!initTime) await initialize();
                else console.debug(`${items.length} items already initialized at ${initTime}ms`);
                if (!initTime) return; // initialization failed, should be signing out ...

                firstSnapshot = false;
                // if account is empty, copy the welcome item from the anonymous account, which should also trigger a request for the secret phrase in order to encrypt the new welcome item
                if (items.length == 0) onEditorDone("/_welcome");

                // if necessary, init secret by triggering a test encryption/decryption
                if (!secret) {
                  const hello_item = { user: user.uid, time: Date.now(), text: "hello" };
                  encryptItem(hello_item)
                    .then(decryptItem)
                    .then((item) => {
                      if (JSON.stringify(item) != JSON.stringify(hello_item)) throw new Error("encryption test failed");
                    })
                    .catch(encryptionError);
                }
              });
            }
            snapshot.docChanges().forEach(function (change) {
              const doc = change.doc;
              // on first snapshot, we only need to append for initalize (see above)
              // and only if items were not returned by server (and initialized) already
              // (otherwise we can just skip the first snapshot, which is hopefully coming
              //  from a local cache so that it is cheap and worse than the server snapshot)
              if (firstSnapshot) {
                if (change.type != "added") console.warn("unexpected change type: ", change.type);
                if (!initTime) {
                  // NOTE: snapshot items do not have updateTime/createTime available
                  items.push(Object.assign(doc.data(), { id: doc.id }));
                }
                return;
              }
              if (doc.metadata.hasPendingWrites) return; // ignore local change
              decryptItem(doc.data()).then((savedItem) => {
                // no need to log initial snapshot
                // console.debug("detected remote change:", change.type, doc.id);
                if (change.type === "added") {
                  // NOTE: remote add is similar to onEditorDone without js, saving, etc
                  let item = {
                    ...savedItem,
                    id: doc.id,
                    savedId: doc.id,
                    savedTime: savedItem.time,
                    savedText: savedItem.text,
                  };
                  items = [item, ...items];
                  // update indices as needed by itemTextChanged
                  items.forEach((item, index) => indexFromId.set(item.id, index));
                  itemTextChanged(0, item.text);
                  lastEditorChangeTime = 0; // disable debounce even if editor focused
                  onEditorChange(editorText); // integrate new item at index 0
                } else if (change.type == "removed") {
                  // NOTE: remote remove is similar to onItemEditing (deletion case)
                  // NOTE: document may be under temporary id if it was added locally
                  let index = indexFromId.get(tempIdFromSavedId.get(doc.id) || doc.id);
                  if (index == undefined) return; // nothing to remove
                  let item = items[index];
                  itemTextChanged(index, ""); // clears label, deps, etc
                  items.splice(index, 1);
                  // update indices as needed by onEditorChange
                  indexFromId = new Map<string, number>();
                  items.forEach((item, index) => indexFromId.set(item.id, index));
                  lastEditorChangeTime = 0; // disable debounce even if editor focused
                  onEditorChange(editorText); // deletion can affect ordering (e.g. due to missingTags)
                  deletedItems.unshift({
                    time: item.savedTime,
                    text: item.savedText,
                  }); // for /undelete
                } else if (change.type == "modified") {
                  // NOTE: remote modify is similar to _write without saving
                  // NOTE: document may be under temporary id if it was added locally
                  let index = indexFromId.get(tempIdFromSavedId.get(doc.id) || doc.id);
                  if (index == undefined) return; // nothing to modify
                  let item = items[index];
                  item.text = item.savedText = savedItem.text;
                  item.time = items[index].savedTime = savedItem.time;
                  // since there is no
                  itemTextChanged(index, item.text); // updates label, deps, etc
                  lastEditorChangeTime = 0; // disable debounce even if editor focused
                  onEditorChange(editorText); // item time/text has changed
                }
              });
            });
          },
          (error) => {
            console.error(error);
            if (error.code == "permission-denied") {
              // NOTE: server (admin) can still preload items if user account was deactivated with encrypted items
              //       (this triggers a prompt for secret phrase on reload, but can be prevented by clearing cookie)
              document.cookie = "__session=;max-age=0"; // delete cookie to prevent preload on reload
              signingOut = true; // no other option at this point
              modal.show({
                content: `Welcome ${window["_user"].name}! Your personal account requires activation. Please email support@mind.page from ${user.email} and include account identifier \`${user.uid}\` in the email.`,
                confirm: "Sign Out",
                background: "confirm",
                onConfirm: signOut,
              });
            }
          }
        );
    }

    onMount(() => {
      // copy console into #console (if it exists)
      console.error = console["_error"]; // restore console.error for redirect
      // NOTE: some errors do not go through console.error but are reported via window.onerror
      const levels = ["debug", "info", "log", "warn", "error"];
      levels.forEach(function (verb) {
        console[verb] = (function (method, verb, div) {
          return function (...args) {
            method(...args);
            if (!consolediv) return;
            var elem = document.createElement("div");
            if (verb.endsWith("error")) verb = "error";
            elem.classList.add("console-" + verb);
            // NOTE: we indicate full eval stack as prefix
            let prefix = evalStack.map((id) => items[indexFromId.get(id)].name).join(" ");
            if (prefix) prefix = "[" + prefix + "] ";
            let text = "";
            if (args.length == 1 && errorMessage(args[0])) text = errorMessage(args[0]);
            else text = args.join(" ") + "\n";
            elem.textContent = prefix + text;
            elem.setAttribute("_time", Date.now().toString());
            elem.setAttribute("_level", levels.indexOf(verb).toString());
            consolediv.appendChild(elem);
            consoleLog.push({
              type: verb,
              stack: evalStack.slice(),
              text: text.trim(),
              time: Date.now(),
              level: levels.indexOf(verb),
            });
            if (consoleLog.length > consoleLogMaxSize) consoleLog = consoleLog.slice(consoleLogMaxSize / 2);

            const summarydiv = document.getElementById("console-summary");
            const summaryelem = document.createElement("span");
            summaryelem.innerText = "·";
            summaryelem.classList.add("console-" + verb);
            summarydiv.appendChild(summaryelem);

            // if console is hidden, make sure summary is visible
            if (consolediv.style.display == "none") summarydiv.style.visibility = "visible";

            // auto-remove after 15 seconds ...
            setTimeout(() => {
              elem.remove();
              summaryelem.remove();
              if (!consolediv) return;
              if (consolediv.childNodes.length == 0) {
                consolediv.style.display = "none";
                summarydiv.style.visibility = "visible";
              }
            }, statusLogExpiration);
          };
        })(console[verb].bind(console), verb);
      });
      // replay any errors during init
      errors.forEach((args) => console.error(...args));

      if (anonymous) {
        console.log("user is anonymous");
      }

      setInterval(checkLayout, 250); // check layout every 250ms
      updateDotted(); // update dotted items

      if (readonly) {
        modal.show({
          content:
            "Welcome to MindPage! This is an **anonymous** demo account. Your edits are visible **only to you**, not sent or stored anywhere, and discarded on reload. Once signed in, your items will be saved securely so that they are readable **only by you, on your devices**.",
          // content: `Welcome ${window["_user"].name}! Your personal account requires activation. Please email support@mind.page from ${user.email} and include account identifier \`${user.uid}\` in the email.`,
          confirm: "Stay Anonymous",
          cancel: "Sign In",
          onCancel: signIn,
          // onConfirm: () => textArea(-1).focus(),
          background: "confirm",
        });
      }

      // console.debug(
      //   `onMount invoked at ${Math.round(window.performance.now())}ms w/ ${
      //     items.length
      //   } items`
      // );
    });

    console.debug(`index.js executed at ${Math.round(window.performance.now())}ms w/ ${items.length} items`);
  }

  let metaKey = false;
  let ctrlKey = false; // NOTE: can cause left click
  let altKey = false;
  let shiftKey = false; // NOTE: can cause unintentional text selection
  function onKeyDown(e: KeyboardEvent) {
    const key = e.code || e.key; // for android compatibility

    if (!initTime) return; // not yet initialized
    metaKey = e.metaKey;
    ctrlKey = e.ctrlKey;
    altKey = e.altKey;
    shiftKey = e.shiftKey;

    // resume-edit items on Shift-(save shortcut)
    if (
      (key == "KeyS" && (e.metaKey || e.ctrlKey) && e.shiftKey) ||
      (key == "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey)
    ) {
      e.preventDefault();
      resumeLastEdit();
      return;
    }

    // disable item editor shortcuts on window, focus on editor instead
    if (focusedItem >= 0) return; // already focused on an item
    if (
      (key == "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) ||
      (key == "KeyS" && (e.metaKey || e.ctrlKey)) ||
      (key == "Slash" && (e.metaKey || e.ctrlKey)) ||
      key == "Tab" ||
      key == "Escape"
    ) {
      e.preventDefault();
      textArea(-1).focus();
      window.top.scrollTo(0, 0);
    }
  }
  function onKeyUp(e: KeyboardEvent) {
    metaKey = e.metaKey;
    ctrlKey = e.ctrlKey;
    altKey = e.altKey;
    shiftKey = e.shiftKey;
  }

  // redirect window.onerror to console.error (or alert if #console not set up yet)
  function onError(e) {
    if (!consolediv) return; // can happen during login process
    let msg = errorMessage(e);
    console.error(msg);
  }

  // retrieve host name, in globalThis.request on server side (see server.ts)
  const hostname = typeof location == "undefined" ? globalThis.hostname : location.hostname;

  // custom directory for some static files, based on hostname
  const hostdir =
    hostname == "mind.page"
      ? ""
      : hostname == "olcan.com"
      ? "olcan.com"
      : hostname == "mindbox.io"
      ? "mindbox.io"
      : "other";
</script>

<!-- NOTE: we put the items on the page as soon as they are initialized, but #loading overlay remains until heights are calculated -->
{#if user && initTime}
  <div class="items" class:multi-column={columnCount > 1}>
    {#each { length: columnCount } as _, column}
      <div class="column">
        {#if column == 0}
          <div id="header" bind:this={headerdiv} on:click={() => textArea(-1).focus()}>
            <div id="header-container" class:focused>
              <div id="editor">
                <Editor
                  id="mindbox"
                  bind:text={editorText}
                  bind:focused
                  showButtons={true}
                  cancelOnDelete={true}
                  createOnAnyModifiers={true}
                  clearOnShiftBackspace={true}
                  allowCommandCtrlBracket={true}
                  onEdited={onEditorChange}
                  onDone={onEditorDone}
                  onPrev={onPrevItem}
                  onNext={onNextItem}
                />
              </div>
              <div class="spacer" />
              {#if user}
                <img
                  id="user"
                  class:anonymous
                  class:readonly
                  class:signedin
                  src={user.photoURL}
                  alt={user.displayName || user.email}
                  title={user.displayName || user.email}
                  on:click={() => (!signedin ? signIn() : signOut())}
                />
              {/if}
            </div>
            <div id="status" on:click={onStatusClick}>
              <span id="console-summary" on:click={onConsoleSummaryClick} />
              <span class="dots">
                {#each { length: dotCount } as _}•{/each}
              </span>
              <span class="triangle"> ▲ </span>
              {#if items.length > 0}
                <div class="counts">
                  {#if matchingItemCount > 0}
                    &nbsp;<span class="matching">{matchingItemCount} matching items</span>
                  {:else}
                    {items.length} items
                  {/if}
                </div>
              {/if}
              <div id="console" bind:this={consolediv} on:click={onConsoleClick} />
            </div>
          </div>
        {/if}

        {#each items as item (item.id)}
          {#if item.column == column && item.index < Math.max(hideIndex, truncateIndex)}
            <Item
              onEditing={onItemEditing}
              onFocused={onItemFocused}
              onEdited={onItemEdited}
              onRun={onItemRun}
              onTouch={onItemTouch}
              onResized={onItemResized}
              {onTagClick}
              {onLinkClick}
              {onLogSummaryClick}
              onPrev={onPrevItem}
              onNext={onNextItem}
              bind:text={item.text}
              bind:editing={item.editing}
              bind:focused={item.focused}
              saving={item.saving}
              running={item.running}
              admin={item.admin}
              hidden={item.index >= hideIndex}
              showLogs={item.showLogs}
              height={item.height}
              time={item.time}
              index={item.index}
              id={item.id}
              label={item.label}
              labelUnique={item.labelUnique}
              labelText={item.labelText}
              hash={item.hash}
              deephash={item.deephash}
              missingTags={item.missingTags.join(" ")}
              matchingTerms={item.matchingTerms.join(" ")}
              matchingTermsSecondary={item.matchingTermsSecondary.join(" ")}
              timeString={item.timeString}
              timeOutOfOrder={item.timeOutOfOrder}
              updateTime={item.updateTime}
              createTime={item.createTime}
              depsString={item.depsString}
              dependentsString={item.dependentsString}
              dotted={item.dotted}
              runnable={item.runnable}
              scripted={item.scripted}
              macroed={item.macroed}
            />
            {#if item.nextColumn >= 0 && item.index < hideIndex - 1}
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
          {#if item.column == column && item.index == hideIndex - 1 && item.index < items.length - 1}
            <!--  NOTE: for simplicity, we put all valid show-toggle buttons on the page but show only the first one by css -->
            {#each tailIndices as tail}
              {#if hideIndex < tail.index}
                <div class="show-toggle" on:click={() => (hideIndex = tail.index)}>
                  show last {tail.timeString}
                </div>
              {/if}
            {/each}
            <div class="show-toggle" on:click={() => (hideIndex = Infinity)}>
              show all {items.length} items
            </div>
          {:else if hideIndex > hideIndexFromRanking && item.column == column && item.index == hideIndexFromRanking - 1 && item.index < items.length - 1}
            <div class="show-toggle" on:click={() => (hideIndex = hideIndexFromRanking)}>hide older items</div>
          {/if}
        {/each}
      </div>
    {/each}
  </div>
{/if}

{#if !user || !initTime || (items.length > 0 && totalItemHeight == 0) || signingIn || signingOut}
  <div id="loading">
    <Circle2 size="60" unit="px" />
  </div>
{:else}<script>
    setTimeout(() => {
      // NOTE: we do not auto-focus the editor on the iPhone, which generally does not allow
      //       programmatic focus except in click handlers, when returning to app, etc
      if (
        document.activeElement.tagName.toLowerCase() != "textarea" &&
        !navigator.platform.startsWith("iPhone") &&
        !document.querySelector(".modal input")
      ) {
        let mindbox = document.getElementById("textarea-mindbox");
        mindbox.selectionStart = mindbox.selectionEnd = mindbox.value.length;
        mindbox.focus();
      }
    });
  </script>{/if}

<Modal bind:this={modal} />

<svelte:window
  on:keydown={onKeyDown}
  on:keyup={onKeyUp}
  on:error={onError}
  on:unhandledrejection={onError}
  on:popstate={onPopState}
  on:scroll={onScroll}
/>

{#if inverted}
  <style>
    html {
      filter: invert(100%);
    }
    img {
      filter: invert(100%);
    }
    textarea {
      caret-color: #0ff !important; /* maintain red (#f00) caret */
    }
  </style>
{/if}

<svelte:head>
  <title>{hostname}</title>
  <link rel="icon" type="image/png" href="{hostdir}/favicon.ico" />
  <link rel="icon" type="image/png" sizes="32x32" href="{hostdir}/favicon-32x32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="{hostdir}/favicon-16x16.png" />
  <link rel="manifest" href="/manifest.json" />
</svelte:head>

<!-- NOTE: we put the items on the page as soon as they are initialized, but #loading overlay remains until heights are calculated -->
<style>
  #loading {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    width: 100%;
    height: 100%;
    min-height: -webkit-fill-available;
    justify-content: center;
    align-items: center;
    /* NOTE: if you add transparency, initial zero-height layout will be visible */
    background: rgba(17, 17, 17, 1);
  }
  #header {
    max-width: 100%;
  }
  #header-container {
    display: flex;
    padding: 10px;
    background: #111; /* matches unfocused editor */
    border-radius: 0 0 5px 5px;
    border-bottom: 1px solid #222;
    /*padding-left: 2px;*/ /* matches 1px super-container padding + 1px container border */
  }
  #header-container.focused {
    /* background: #232; */
    background: #222; /* #222 matches #user background */
    border-bottom: 1px solid #333;
  }
  #editor {
    width: 100%;
  }
  /* remove dashed border when top editor is unfocused */
  :global(#header #editor .backdrop:not(.focused)) {
    border: 1px solid transparent;
  }
  /* lighten solid border when top editor is focused */
  :global(#header #editor .backdrop.focused) {
    border: 1px solid #333;
    /* border: 1px solid transparent; */
  }
  .spacer {
    flex-grow: 1;
  }
  #user {
    height: 56px; /* 46px = focused height of single-line editor (also see @media query below) */
    width: 56px;
    min-width: 56px; /* seems necessary to ensure full width inside flex */
    border-radius: 50%;
    margin: -5px;
    margin-left: 5px;
    background: #222;
    cursor: pointer;
    overflow: hidden;
  }
  #user.anonymous:not(.readonly).signedin {
    background: green;
  }
  #console {
    display: none;
    position: absolute;
    min-height: 20px; /* covers #console-summary (w/ +8px padding) */
    min-width: 60px; /* covers #console-summary */
    top: 0;
    left: 0;
    z-index: 10;
    padding: 4px;
    color: #999;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 4px;
    border: 1px solid #222;
    font-family: monospace;
    /* pointer-events: none; */
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
    color: #777;
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
  #status {
    padding: 4px;
    height: 20px;
    text-align: center;
    font-family: monospace;
    font-size: 12px;
    color: #999;
    cursor: pointer;
    position: relative;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  #status #console-summary {
    position: absolute;
    left: 0;
    top: 0;
    padding-top: 4px;
    height: 24px; /* matches #status height(+padding) above */
    min-width: 60px; /* ensure clickability */
    max-width: 30%; /* try not to cover center (item dots) */
    text-align: left;
    overflow: hidden;
    padding-left: 4px;
  }
  #status .counts {
    font-family: Avenir Next, sans-serif;
    position: absolute;
    right: 0;
    top: 0;
    padding-right: 4px; /* matches .corner inset on first item */
    padding-top: 4px;
  }
  :global(#status .counts .unit, #status .counts .comma) {
    color: #666;
    font-size: 80%;
  }
  #status .counts .matching {
    color: #9f9;
  }

  .items {
    width: 100%;
    display: flex;
    /* prevent horizontal overflow which causes stuck zoom-out on iOS Safari */
    /* (note that overflow-x did not work but this is fine too) */
    overflow: hidden;
    /* fill full height of page even if no items are shown */
    /* otherwise (tapped) #console can be cut off at the bottom when there are no items */
    min-height: 100%;
    min-height: -webkit-fill-available;
    /* bottom padding for easier tapping on last item */
    padding-bottom: 200px;
  }
  /* .items.multi-column {
    padding-bottom: 0;
  } */
  :global(#sapper) {
    min-height: 100%;
    min-height: -webkit-fill-available;
  }

  .column {
    flex: 1;
    /* NOTE: BOTH min/max width are necessary to get proper flexing behavior */
    min-width: 0px;
    max-width: 750px;
    /* allow absolute-positioned .hidden items */
    position: relative;
  }
  .column:not(:last-child) {
    padding-right: 8px;
  }
  .section-separator {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 40px; /* 40px offset height assumed by column layout */
    color: #444; /* same as time indicators */
    font-size: 16px;
    font-family: Avenir Next, sans-serif;
  }
  .section-separator .arrows {
    margin-bottom: 5px; /* aligns better w/ surrounding text */
    font-family: monospace;
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

  .show-toggle {
    display: flex;
    justify-content: center;
    align-items: center;
    color: #999;
    background: #222;
    /* color: black; */
    /* background: #666; */
    font-weight: 500;
    font-size: 16px;
    font-family: Avenir Next, sans-serif;
    border-radius: 4px;
    cursor: pointer;
    margin: 28px auto; /* same as having time string */
    padding: 15px 30px;
    width: fit-content;
    white-space: nowrap;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }

  .show-toggle + .show-toggle {
    display: none;
  }

  /* override italic comment style of sunburst */
  :global(.hljs-comment) {
    font-style: normal;
    color: #666;
  }
  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    #header-container {
      /*padding-left: 1px;*/ /* matches 1px container border, no super-container padding */
      padding-left: 10px; /* not best use of space, but looks good and avoids edge on curved screens */
      padding-right: 6px; /* reduced padding to save space */
    }
    #user {
      height: 55px; /* 45px = height of single-line editor (on narrow window) */
      width: 55px;
      min-width: 55px;
      /* margin: 0; */
      margin-left: 2px; /* reduce to minimal margin */
    }
  }
</style>
