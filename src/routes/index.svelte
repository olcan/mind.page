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
  import Editor from "../components/Editor.svelte";
  import Item from "../components/Item.svelte";
  import { tick } from "svelte";
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
            },
    });
    Object.defineProperty(window, "_stack", { get: () => evalStack.slice() }); // return copy not reference
    Object.defineProperty(window, "_this", { get: () => _item(evalStack[evalStack.length - 1]) });
    Object.defineProperty(window, "_that", { get: () => _item(evalStack[0]) });
    window["_item"] = _item;
    window["_items"] = _items;
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
    // general-purpose key-value store with session/item lifetime
    get store(): object {
      let _item = item(this.id);
      if (!_item.store) _item.store = {};
      return _item.store;
    }

    read(type: string = "", options: object = {}) {
      const item = items[this.index];
      let content = [];
      // include dependencies in order, _before_ item itself
      if (options["include_deps"]) {
        options["include_deps"] = false; // deps are recursive already
        item.deps.forEach((id) => {
          const dep = items[indexFromId.get(id)];
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
        __item.text = this.text.replace(/(^|\n) *```(\w*?_log)\n(?: *```|.*?\n *```) *(\n|$)/gs, "$3");
        if (text) __item.text = appendBlock(this.text, type, text);
      } else {
        if (type == "") __item.text = text;
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

    write_log(options = {}) {
      options = _.merge(
        {
          since: "run",
          level: 1,
          type: "_log",
          item: "self",
        },
        options
      );
      this.write(this.console_log(options).join("\n"), options["type"]);
      if (options["type"] == "_log" || options["show_logs"]) this.show_logs();
    }

    write_log_any(options = {}) {
      return this.write_log(Object.assign({ item: "any" }, options));
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
        if (options["async"]) evaljs = ["_this.start(async (done) => {", evaljs, "}) // _this.start"].join("\n");
        if (options["trigger"]) evaljs = [`const __trigger = '${options["trigger"]}';`, evaljs].join("\n");
        evaljs = ["'use strict';", `const _id = '${this.id}';`, "const _this = _item(_id);", evaljs].join("\n");
      }
      // replace any remaining $id, $hash, $deephash, just like in macros or _html(_*) blocks
      evaljs = evaljs.replace(/(^|[^\\])\$id/g, "$1" + this.id);
      evaljs = evaljs.replace(/(^|[^\\])\$hash/g, "$1" + this.hash);
      evaljs = evaljs.replace(/(^|[^\\])\$deephash/g, "$1" + this.deephash);
      // store eval text under item.store[debug_trigger] for debugging, including a reverse stack string
      let stack = evalStack
        .map((id) => item(id).name)
        .concat(this.name)
        .reverse()
        .join(" < ");
      this.store["debug_" + (options["trigger"] || "other")] = appendBlock(
        `\`eval(…)\` on ${stack}`,
        "js_input",
        addLineNumbers(evaljs)
      );
      // run eval within try/catch block
      item(this.id).lastEvalTime = Date.now();
      if (options["trigger"] == "run") item(this.id).lastRunTime = Date.now();
      evalStack.push(this.id);
      try {
        const out = eval.call(window, evaljs);
        if (evalStack.pop() != this.id) console.error("invalid stack");
        return out;
      } catch (e) {
        console.error(e);
        // invalidate element cache for <script> tags
        if (options["trigger"].startsWith("script_")) invalidateElemCache(this.id);
        if (evalStack.pop() != this.id) console.error("invalid stack");
        throw e;
      }
    }

    // starts an async task in context of this item
    // if no function is given, returns 'done' function to be invoked later by caller
    // if function is given (can be async), passes done into that and returns promise
    start(func = null) {
      const done = (output, log_options = {}) => {
        if (output) this.write(output);
        this.write_log(log_options);
        item(this.id).running = false;
      };
      if (!func) {
        // start is invoked sync, caller will invoke done() async later
        item(this.id).running = true;
        return done;
      }
      return this.resume(async () => {
        item(this.id).running = true;
        // ensure spinner is visible in case function blocks updates for extended period
        // NOTE: turns out tick() is not sufficient, and even polling for DOM state did not work without a _delay(50)
        await tick();
        await this.delay(50); // ensure spinner is visible
        await func(done);
      });
    }

    // resumes async task by calling (async) function after restoring stack
    // NOTE: stack should be either [this.id] or [], because we do not allow nested eval of start/resume/etc
    // NOTE: for the stack to remain valid, we can NOT await on an async function since that would give up control while item is still on the stack, causing misattribution and potential corruption (with multiple async tasks popping each other off the stack); instead we allow item to popped off and leave it up to item code to ensure that _this.resume() is invoked to restore stack as needed -- note that _this remains valid when stack is empty because it is defined within lexical scope in eval()
    async resume(func) {
      // console.debug(evalStack.map((id) => item(id).name));
      if (evalStack.length > 1 || (evalStack.length == 1 && evalStack[0] != this.id)) {
        console.error(`unexpected eval stack [${evalStack.map((id) => item(id).name)}] at resume()`);
      }
      evalStack.push(this.id);
      try {
        const out = func();
        if (evalStack.pop() != this.id) console.error("invalid stack");
        return out;
      } catch (e) {
        console.error(e);
        if (evalStack.pop() != this.id) console.error("invalid stack");
        throw e;
      }
    }

    // like resume, but returns "deferred" function to be invoked by caller
    // useful for passing callback functions, e.g. into Promise.then()
    defer(func) {
      const _item = this; // capture for deferred function
      return function (...args) {
        _item.resume(() => func(...args));
      };
    }

    // dispatch = setTimeout on deferred function
    dispatch(func, ms, ...args) {
      setTimeout(this.defer(func), ms, ...args);
    }

    // promise = new Promise on deferred executor function
    promise(func) {
      return new Promise(this.defer(func));
    }

    // delay = promise that resolves on a timeout
    delay(ms) {
      return this.promise((resolve) => setTimeout(resolve, ms));
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
  let tailIndices = [];
  let newestTime = 0;
  let oldestTime = Infinity;
  let oldestTimeString = "";
  let defaultHeaderHeight = 0;
  let defaultItemHeight = 0; // if zero, initial layout will be single-column
  let totalItemHeight = 0;
  let lastLayoutTime = 0;

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
    columnHeights[0] = headerdiv ? headerdiv.offsetHeight : defaultHeaderHeight; // first column includes header
    let lastTimeString = "";
    let topMovedIndex = items.length;
    newestTime = 0;
    oldestTime = Infinity;
    oldestTimeString = "";
    totalItemHeight = 0;
    lastLayoutTime = Date.now();

    items.forEach((item, index) => {
      if (index < item.index && index < topMovedIndex) topMovedIndex = index;
      item.index = index;
      indexFromId.set(item.id, index);
      if (item.dotted) dotCount++;
      if (item.editing) editingItems.push(index);
      if (item.focused) focusedItem = index;

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
    if (topMovedIndex < items.length) {
      setTimeout(() => {
        // allow dom update before calculating new position
        const div = document.querySelector("#super-container-" + items[topMovedIndex].id);
        if (!div) return; // item hidden
        const itemTop = (div as HTMLElement).offsetTop;
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
  function onEditorChange(text: string) {
    // keep history entry 0 updated, reset index on changes
    if (text != sessionHistory[sessionHistoryIndex]) {
      sessionHistoryIndex = 0;
      if (sessionHistory.length == 0) sessionHistory = [text];
      else sessionHistory[0] = text;
    }

    // if editor has focus, and it is too soon since last change/return, debounce
    if (document.activeElement == textArea(-1) && Date.now() - lastEditorChangeTime < editorDebounceTime) {
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
    // console.debug("onEditorChange", editorText);
    lastEditorChangeTime = Infinity; // force minimum wait for next change

    text = text.toLowerCase().trim();
    const tags = parseTags(text);
    let terms = _.uniq(
      text
        .split(/\s+/)
        .concat(tags.all)
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
    if (idsFromLabel.get(terms[0])?.length == 1) {
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

      // match non-tag terms (anywhere in text)
      item.matchingTerms = item.matchingTerms.concat(terms.filter((t) => t[0] != "#" && item.lctext.includes(t)));

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
              item.dependentsString.toLowerCase().includes(t)
          ),
          terms.filter(
            (t) =>
              t[0] != "#" &&
              (item.depsString.toLowerCase().includes(t) || item.dependentsString.toLowerCase().includes(t))
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
    hideIndex = tailIndex;

    // determine other non-trivial "tail times" <= tailTime but > oldestTime
    const tailTime24h = Date.now() - 24 * 3600 * 1000;
    const tailTime7d = Date.now() - 7 * 24 * 3600 * 1000;
    const tailTime30d = Date.now() - 30 * 24 * 3600 * 1000;
    tailIndices = [];
    if (tailTime24h <= tailTime) {
      const extendedTailIndex = tailIndex + items.slice(tailIndex).filter((item) => item.time >= tailTime24h).length;
      // if no matching items, show last 24h, so take extendedTailIndex (even if == items.length)
      if (matchingItemCount == 0) hideIndex = extendedTailIndex;
      if (extendedTailIndex > tailIndex && extendedTailIndex < items.length) {
        tailIndices.push({ index: extendedTailIndex, timeString: "24h", time: items[extendedTailIndex].time });
        tailIndex = extendedTailIndex;
        tailTime = items[extendedTailIndex].time;
      }
    }
    if (tailTime7d <= tailTime) {
      const extendedTailIndex = tailIndex + items.slice(tailIndex).filter((item) => item.time >= tailTime7d).length;
      if (extendedTailIndex > tailIndex && extendedTailIndex < items.length) {
        tailIndices.push({ index: extendedTailIndex, timeString: "7d", time: items[extendedTailIndex].time });
        tailIndex = extendedTailIndex;
        tailTime = items[extendedTailIndex].time;
      }
    }
    if (tailTime30d <= tailTime) {
      const extendedTailIndex = tailIndex + items.slice(tailIndex).filter((item) => item.time >= tailTime30d).length;
      if (extendedTailIndex > tailIndex && extendedTailIndex < items.length) {
        tailIndices.push({ index: extendedTailIndex, timeString: "30d", time: items[extendedTailIndex].time });
        tailIndex = extendedTailIndex;
        tailTime = items[extendedTailIndex].time;
      }
    }
    // console.debug(tailIndices);

    updateItemLayout();
    lastEditorChangeTime = Infinity; // force minimum wait for next change
    setTimeout(updateDotted, 0); // show/hide dotted/undotted items
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

  function onPopState(e) {
    readonly = anonymous && !location.href.match(/user=anonymous/);
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
    localStorage.removeItem("user");
    window.sessionStorage.removeItem("signin_pending");
    document.cookie = "__session=;max-age=0"; // delete cookie for server
  }

  function signOut() {
    if (!firebase().auth().currentUser) return; // not logged in yet, so ignore click for now
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
    item.runnable = item.lctext.match(/\s*```js_input\s/);
    item.scripted = item.lctext.match(/<script.*?>/);
    item.macroed = item.lctext.match(/<<.*?>>/);

    const tags = parseTags(item.lctext);
    item.tags = tags.all;
    item.tagsVisible = tags.visible;
    item.tagsHidden = tags.hidden;
    item.tagsRaw = tags.raw;
    item.tagsAlt = _.uniq(_.flattenDeep(item.tags.concat(item.tags.map(altTags))));
    item.tagsHiddenAlt = _.uniq(_.flattenDeep(item.tagsHidden.concat(item.tagsHidden.map(altTags))));
    // item.log = item.tags.includes("#log"); (must be label, see below)
    item.context = item.tagsRaw.includes("#_context");
    item.init = item.tagsRaw.includes("#_init");
    item.async = item.tagsRaw.includes("#_async");
    item.debug = item.tagsRaw.includes("#_debug");
    const pintags = item.tagsRaw.filter((t) => t.match(/^#_pin(?:\/|$)/));
    item.pinned = pintags.length > 0;
    item.pinTerm = pintags[0] || "";
    item.dotted = pintags.findIndex((t) => t.match(/^#_pin\/dot(?:\/|$)/)) >= 0;
    item.dotTerm = pintags.filter((t) => t.match(/^#_pin\/dot(?:\/|$)/))[0] || "";

    // if item stats with a visible tag, it is taken as a "label" for the item
    // (we allow some tags/macros to precede the label tag for styling purposes)
    const prevLabel = item.label;
    item.header = item.lctext.replace(/^<.*>\s+#/, "#").match(/^.*?(?:\n|$)/)[0];
    item.label = item.header.startsWith(item.tagsVisible[0]) ? item.tagsVisible[0] : "";
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
    item.log = item.label == "#log";
    // name is always unique and either unique label or id:<id>
    item.name = item.labelUnique ? item.labelText : "id:" + item.id;

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

  let sessionCounter = 0; // to ensure unique increasing temporary ids for this session
  let sessionHistory = [];
  let sessionHistoryIndex = 0;
  let tempIdFromSavedId = new Map<string, string>();
  let editorText = "";
  function onEditorDone(text: string, e: KeyboardEvent = null, cancelled: boolean = false, run: boolean = false) {
    if (cancelled) {
      if (e?.code == "Escape") {
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
    // NOTE: default is to create item in editing mode, unless any 2+ modifiers are held
    //       (or edit:true|false is specified by custom command function)
    //       (some modifier combinations, e.g. Ctrl+Alt, may be blocked by browsers)
    let editing = e && (e.metaKey ? 1 : 0) + (e.ctrlKey ? 1 : 0) + (e.altKey ? 1 : 0) < 2;

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
            try {
              const obj = _item("#commands" + cmd).eval(`run(\`${args}\`)`, { trigger: "command" });
              if (!obj) {
                onEditorChange((editorText = ""));
                return;
              } else if (typeof obj == "string") {
                onEditorChange((editorText = obj));
                return;
              } else if (typeof obj != "object" || !obj.text || typeof obj.text != "string") {
                alert(
                  `#commands${cmd}: run(\`${args}\`) returned invalid value; must be of the form {text:"...",edit:true|false}`
                );
                return;
              }
              text = obj.text;
              if (obj.edit != undefined)
                // if undefined use key-based default
                editing = obj.edit == true;
            } catch (e) {
              const log = _item("#commands" + cmd).console_log(-1 /*lastEvalTime*/, 4 /*errors*/);
              let msg = [`#commands${cmd} run(\`${args}\`) failed:`, ...log, e].join("\n");
              alert(msg);
              throw e;
            }
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

    // NOTE: command can do this if indeed useful
    // if command, just clear the arguments, keep the command
    // (useful for repeated commands of the same type)
    // if (editorText.match(/^\/\w+ ?/)) {
    //   editorText = editorText.replace(/(^\/\w+ ?).*$/s, "$1");
    // } else {
    // if not command, but starts with a tag, keep if non-unique label
    // (useful for adding labeled items, e.g. todo items, without losing context)
    editorText =
      !clearLabel &&
      items[0].label &&
      !items[0].labelUnique &&
      items[0].labelText &&
      editorText.startsWith(items[0].labelText + " ")
        ? items[0].labelText + " "
        : "";
    // }

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

    firestore()
      .collection(readonly ? "items-tmp" : "items")
      .add(itemToSave)
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
    item.savedText = savedItem.text;
    item.savedTime = savedItem.time;
    item.saving = false;
    items[index] = item; // trigger dom update
    if (item.saveClosure) {
      item.saveClosure(item.id);
      delete item.saveClosure;
    }
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

  function appendBlock(text: string, type: string, block) {
    if (typeof block != "string") block = "" + block;
    if (block.length > 0 && block[block.length - 1] != "\n") block += "\n";
    block = "\n```" + type + "\n" + block + "```";
    const empty = "\n```" + type + "\n```";
    const regex = "(?:^|\\n) *```" + type + "\\n.*?\\s*```";
    if (text.match(RegExp(regex, "s"))) {
      let count = 0;
      text = text.replace(RegExp(regex, "gs"), () => (count++ == 0 ? block : empty));
    } else {
      text += block;
    }
    return text;
  }

  function appendJSOutput(index: number): string {
    let item = items[index];
    // check js_input, must mention 'done' if async mode
    const async = item.async || item.deps.map((id) => items[indexFromId.get(id)].async).includes(true);
    let jsin = extractBlock(item.text, "js_input");
    if (!jsin) return item.text; // missing or empty, ignore
    if (async && !jsin.match(/\bdone\b/)) {
      alert(`${item.name}: can not run async js_input without any reference to 'done'`);
      return item.text;
    }
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
      time: item.time,
      text: item.text,
    };
    if (readonly) {
      // if read-only, we can only "update" items added (to items-tmp) in this session
      if (tempIdFromSavedId.get(item.savedId)) {
        firestore()
          .collection("items-tmp")
          .doc(item.savedId)
          .update({ user: user.uid, ...itemToSave })
          .then(() => {
            onItemSaved(item.id, itemToSave);
          })
          .catch(console.error);
      } else {
        firestore()
          .collection("items-tmp")
          .add({ user: user.uid, ...itemToSave })
          .then((doc) => {
            let index = indexFromId.get(item.id);
            if (index == undefined) return; // deleted
            items[index].savedId = doc.id;
            onItemSaved(item.id, itemToSave);
            tempIdFromSavedId.set(items[index].savedId, item.id); // can update next time
          })
          .catch(console.error);
      }
    } else {
      firestore()
        .collection(readonly ? "items-tmp" : "items")
        .doc(item.savedId)
        .update(itemToSave)
        .then(() => {
          onItemSaved(item.id, itemToSave);
        })
        .catch(console.error);
    }

    if (!readonly) {
      // also save to history ...
      firestore()
        .collection("history")
        .add({ user: user.uid, item: item.savedId, ...itemToSave })
        .catch(console.error);
    }
  }

  // https://stackoverflow.com/a/9039885
  function iOS() {
    return (
      ["iPad Simulator", "iPhone Simulator", "iPod Simulator", "iPad", "iPhone", "iPod"].includes(navigator.platform) ||
      // iPad on iOS 13 detection
      (navigator.userAgent.includes("Mac") && "ontouchend" in document)
    );
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
      if (item.time != item.savedTime) onEditorChange(editorText); // time has changed
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
        // we can skip delete if read-only and item not created under items-tmp
        if (item.savedId && (!readonly || tempIdFromSavedId.get(item.savedId))) {
          firestore()
            .collection(readonly ? "items-tmp" : "items")
            .doc(item.savedId)
            .delete()
            .catch(console.error);
        }
      } else {
        itemTextChanged(index, item.text);
        // clear _output and execute javascript unless cancelled
        if (run && !cancelled) {
          // empty out any *_output|*_log blocks as they should be re-generated
          item.text = item.text.replace(/(^|\n) *```(\w*?_output)\n(?: *```|.*?\n *```) *(\n|$)/gs, "$1```$2\n```$3");
          item.text = item.text.replace(
            /(^|\n) *```(\w*?_log)\n(?: *```|.*?\n *```) *(\n|$)/gs,
            "$3" // remove so errors do not leave empty blocks
          );
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
    // empty out any *_output|*_log blocks as they should be re-generated
    item.text = item.text.replace(/(^|\n) *```(\w*?_output)\n(?: *```|.*?\n *```) *(\n|$)/gs, "$1```$2\n```$3");
    item.text = item.text.replace(
      /(^|\n) *```(\w*?_log)\n(?: *```|.*?\n *```) *(\n|$)/gs,
      "$3" // remove so errors do not leave empty blocks
    );
    itemTextChanged(index, item.text); // updates tags, label, deps, etc before JS eval
    appendJSOutput(index);
    item.time = Date.now();
    if (!item.editing) saveItem(item.id);
    lastEditorChangeTime = 0; // force immediate update (editor should not be focused but just in case)
    onEditorChange(editorText); // item time/text has changed
  }

  function onItemTouch(index: number) {
    if (items[index].log) {
      alert("#log item can not be moved up");
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

  import { onMount } from "svelte";
  import { hashCode, numberWithCommas, extractBlock, parseTags, renderTag, invalidateElemCache } from "../util.js";

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
  let hiddenItems = new Set(["QbtH06q6y6GY4ONPzq8N" /* welcome item */]);
  function initialize() {
    // filter hidden items on readonly account
    if (readonly) items = items.filter((item) => !hiddenItems.has(item.id));

    indexFromId = new Map<string, number>(); // needed for initial itemTextChanged
    items.forEach((item, index) => indexFromId.set(item.id, index));
    items.forEach((item, index) => {
      itemTextChanged(index, item.text, false); // deps handled below after index assignment
      item.hidden = hiddenItems.has(item.id);
      item.savedId = item.id;
      item.savedText = item.text;
      item.savedTime = item.time;
      // NOTE: we also initialized other state here to have a central listing
      // state used in onEditorChange
      item.tagMatches = 0;
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
      item.timeString = "";
      item.timeOutOfOrder = false;
      item.height = 0;
      item.column = 0;
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
  }

  function signIn() {
    if (firebase().auth().currentUser) return; // already signed in, must sign out first
    // blur active element as caret can show through loading div
    // (can require dispatch on chrome if triggered from active element)
    setTimeout(() => (document.activeElement as HTMLElement).blur());
    resetUser();
    let provider = new window.firebase.auth.GoogleAuthProvider();
    firebase().auth().useDeviceLanguage();
    // firebase().auth().setPersistence("none")
    // firebase().auth().setPersistence("session")
    firebase().auth().setPersistence("local");
    // NOTE: getRedirectResult() seem to be redundant given onAuthStateChanged
    window.sessionStorage.setItem("signin_pending", "1");
    document.cookie = "__session=signin_pending;max-age=600"; // temporary setting for server post-redirect
    firebase().auth().signInWithRedirect(provider);
    // NOTE: signInWithPopup also requires a reload since we are currently unable to cleanly re-initialize items via firebase realtime snapshot once they have already been initialize via server-side request; reloading allows the next server response to be ignored so that session cookie can be set; forced reload also means that we might as well do a redirect which can be cleaner anyway (esp. on mobile, as stated on https://firebase.google.com/docs/auth/web/google-signin)
    // firebase()
    //   .auth()
    //   .signInWithPopup(provider)
    //   .then(() => location.reload())
    //   .catch(console.error);
  }

  function useAnonymousAccount() {
    console.log("using anonymous account");
    user = {
      photoURL: "/incognito.png",
      displayName: "Anonymous",
      uid: "anonymous",
    };
    anonymous = true;
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
    if (!user && localStorage.getItem("user")) {
      user = JSON.parse(localStorage.getItem("user"));
      console.debug(`restored user ${user.email} from local storage`);
      if (user.uid == "y2swh7JY2ScO5soV7mJMHVltAOX2" && location.href.match(/user=anonymous/)) useAnonymousAccount();
    } else if (window.sessionStorage.getItem("signin_pending")) {
      user = null;
    } else {
      useAnonymousAccount();
      document.cookie = "__session=;max-age=0"; // clear just in case
    }
    anonymous = user?.uid == "anonymous";
    readonly = anonymous && !location.href.match(/user=anonymous/);

    // if items were returned from server, confirm user, then initialize if valid
    if (items.length > 0) {
      if (window.sessionStorage.getItem("signin_pending")) {
        console.warn(`ignoring ${items.length} items received while signing in`);
        items = [];
      } else if (user && user.uid != items[0].user) {
        // items are for wrong user, usually anonymous, due to missing cookie
        // (you can test this with document.cookie='__session=;max-age=0' in console)
        console.warn(`ignoring ${items.length} items received for wrong user (${items[0].user})`);
        items = [];
      } else {
        // NOTE: at this point item heights (and totalItemHeight) will be zero and the loading indicator stays, but we need the items on the page to compute their heights, which will trigger updated layout through onItemResized
        initialize();
      }
    }

    // if fragment corresponds to an item tag or id, focus on that item immediately ...
    if (items.length > 0 && location.href.match(/#.+$/)) {
      const tag = location.href.match(/#.+$/)[0];
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

    // listen for auth state change ...
    firebase()
      .auth()
      .onAuthStateChanged((authUser) => {
        // console.debug("onAuthStateChanged", user, authUser);
        if (!authUser) return;
        resetUser(); // clean up first
        user = authUser;
        console.log("signed in", user.email);
        localStorage.setItem("user", JSON.stringify(user));
        anonymous = readonly = false; // just in case (should already be false)
        signedin = true;

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

        // NOTE: olcans@gmail.com signed in with user=anonymous query will ACT as anonymous account
        //       (this is the only case where user != firebase().auth().currentUser)
        if (user.uid == "y2swh7JY2ScO5soV7mJMHVltAOX2" && location.href.match(/user=anonymous/)) useAnonymousAccount();

        initFirebaseRealtime();
      });

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
      if (Date.now() - lastLayoutTime > 60000) {
        // console.debug(
        //   `updating layout after more than a minute since last layout`
        // );
        updateItemLayout();
        return;
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
              setTimeout(() => {
                console.debug(`${items.length} items synchronized at ${Math.round(performance.now())}ms`);
                if (!initTime) initialize();
                firstSnapshot = false;
                // if account is empty, fetch the welcome item from the anonymous account ...
                if (items.length == 0) onEditorDone("/_welcome");
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
              // no need to log initial snapshot
              // console.debug("detected remote change:", change.type, doc.id);
              if (change.type === "added") {
                // NOTE: remote add is similar to onEditorDone without js, saving, etc
                let item = Object.assign(doc.data(), {
                  id: doc.id,
                  savedId: doc.id,
                  savedTime: doc.data().time,
                  savedText: doc.data().text,
                });
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
                item.text = item.savedText = doc.data().text;
                item.time = items[index].savedTime = doc.data().time;
                // since there is no
                itemTextChanged(index, item.text); // updates label, deps, etc
                lastEditorChangeTime = 0; // disable debounce even if editor focused
                onEditorChange(editorText); // item time/text has changed
              }
            });
          },
          (error) => {
            if (error.code == "permission-denied")
              alert(
                `This account requires activation. Plese email support@mind.page from your email address ${user.email} and specify your account id:${user.uid}. Signing you out for now!`
              );
            console.error(error);
            signOut();
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

      if (anonymous) console.log("user is anonymous");
      if (initTime) console.debug(`${items.length} items initialized at ${initTime}ms`);

      setInterval(checkLayout, 250); // check layout every 250ms
      updateDotted(); // update dotted items

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
    metaKey = e.metaKey;
    ctrlKey = e.ctrlKey;
    altKey = e.altKey;
    shiftKey = e.shiftKey;

    // resume-edit items on Shift-(save shortcut)
    if (
      (e.code == "KeyS" && (e.metaKey || e.ctrlKey) && e.shiftKey) ||
      (e.code == "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey)
    ) {
      e.preventDefault();
      resumeLastEdit();
      return;
    }

    // disable item editor shortcuts on window, focus on editor instead
    if (focusedItem >= 0) return; // already focused on an item
    if (
      (e.code == "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) ||
      (e.code == "KeyS" && (e.metaKey || e.ctrlKey)) ||
      (e.code == "Slash" && (e.metaKey || e.ctrlKey)) ||
      e.code == "Tab" ||
      e.code == "Escape"
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
</script>

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
                cancelOnDelete={true}
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
                {@html oldestTimeString.replace(/(\D+)/, '<span class="unit">$1</span>')}&nbsp;
                {@html numberWithCommas(textLength).replace(/,/g, '<span class="comma">,</span>') +
                  '<span class="unit">B</span>'}&nbsp;
                {items.length}
                {#if matchingItemCount > 0}
                  &nbsp;<span class="matching">{matchingItemCount}</span>
                {/if}
              </div>
            {/if}
            <div id="console" bind:this={consolediv} on:click={onConsoleClick} />
          </div>
        </div>
      {/if}

      {#each items as item (item.id)}
        {#if item.column == column && item.index < hideIndex}
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
            bind:saving={item.saving}
            bind:running={item.running}
            bind:hidden={item.hidden}
            bind:showLogs={item.showLogs}
            bind:height={item.height}
            bind:time={item.time}
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
          {#if item.nextColumn >= 0}
            <div class="section-separator">
              <hr />
              {item.index + 2}<span class="arrows">{item.arrows}</span>{#if item.nextItemInColumn >= 0}
                &nbsp;
                {item.nextItemInColumn + 1}<span class="arrows">↓</span>
              {/if}
              <hr />
            </div>
          {/if}
        {:else if item.column == column && item.index == hideIndex}
          {#each tailIndices as tail}
            {#if hideIndex < tail.index}
              <div class="show-more" on:click={() => (hideIndex = tail.index)}>
                <span class="show-time">{tail.timeString}</span>
                show older items
                <span class="show-count">{tail.index}</span>
              </div>
            {/if}
          {/each}
          <div class="show-more" on:click={() => (hideIndex = Infinity)}>
            <span class="show-time">{oldestTimeString}</span>
            show all items
            <span class="show-count">{items.length}</span>
          </div>
        {/if}
      {/each}
    </div>
  {/each}
</div>

{#if !user || !initTime || (items.length > 0 && totalItemHeight == 0)}
  <div id="loading">
    <Circle2 size="60" unit="px" />
  </div>
{:else}<script>
    setTimeout(() => {
      // NOTE: we do not auto-focus the editor on the iPhone, which generally does not allow
      //       programmatic focus except in click handlers, when returning to app, etc
      if (document.activeElement.tagName.toLowerCase() != "textarea" && !navigator.platform.startsWith("iPhone")) {
        let mindbox = document.getElementById("textarea-mindbox");
        mindbox.selectionStart = mindbox.selectionEnd = mindbox.value.length;
        mindbox.focus();
      }
    });
  </script>{/if}

<svelte:window
  on:keydown={onKeyDown}
  on:keyup={onKeyUp}
  on:error={onError}
  on:unhandledrejection={onError}
  on:popstate={onPopState}
  on:scroll={onScroll}
/>

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
    padding: 4px 0;
    background: #111; /* matches unfocused editor */
    border-radius: 0 0 4px 4px;
  }
  #header-container.focused {
    background: #111;
  }
  #editor {
    margin-right: 4px;
    width: 100%;
  }
  /* remove dashed border when top editor is unfocused */
  :global(#header #editor .backdrop:not(.focused)) {
    border: 1px solid transparent;
  }
  /* lighten up border when focused */
  /* :global(#header #editor .backdrop.focused) {
    border: 1px solid #383838;
  } */
  .spacer {
    flex-grow: 1;
  }
  #user {
    height: 46px; /* match focused height of single-line editor (also see @media query below) */
    width: 46px;
    min-width: 46px; /* seems necessary to ensure full width inside flex */
    margin-right: 4px;
    border-radius: 50%;
    background: #222;
    cursor: pointer;
    overflow: hidden;
  }
  #user.anonymous:not(.readonly) {
    background: red;
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
    font-family: Avenir Next, Helvetica;
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
  :global(#sapper) {
    min-height: 100%;
    min-height: -webkit-fill-available;
  }

  .column {
    flex: 1;
    /* NOTE: BOTH min/max width are necessary to get proper flexing behavior */
    min-width: 0px;
    max-width: 750px;
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
    font-family: Avenir Next, Helvetica;
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

  .show-more {
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    /* color: #999; */
    /* background: #222; */
    color: black;
    background: #999;
    font-size: 16px;
    font-family: Avenir Next, Helvetica;
    font-weight: 500;
    border-radius: 4px;
    cursor: pointer;
    margin: 4px 0;
    height: 40px;
  }
  .show-more .show-time {
    position: absolute;
    left: 10px;
  }
  .show-more .show-count {
    position: absolute;
    right: 10px;
  }

  .show-more + .show-more {
    display: none;
  }

  /* override italic comment style of sunburst */
  :global(.hljs-comment) {
    font-style: normal;
    color: #666;
  }
  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    #user {
      height: 45px; /* must match height of single-line editor (on narrow window) */
      width: 45px;
      min-width: 45px;
    }
  }
</style>
