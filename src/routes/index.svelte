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
  let admin = false;
  let anonymous = false;
  let readonly = false;
  let inverted = isClient && localStorage.getItem("mindpage_inverted") == "true";
  let narrating = isClient && localStorage.getItem("mindpage_narrating") != null;
  let green_screen = isClient && localStorage.getItem("mindpage_green_screen") == "true";
  if (isClient) window["_green_screen"] = green_screen;
  let intro = true; // larger centered narration window
  let modal;

  let evalStack = [];
  function addLineNumbers(code) {
    let lineno = 1;
    return code
      .split("\n")
      .map((line) => `/*${lineno++}*/ ${line}`)
      .join("\n");
  }

  function update_dom() {
    return new Promise((resolve) => {
      // skip animation frame to ensure DOM is updated for running=true
      // (otherwise only option is an arbitrary delay since polling DOM does not work)
      // (see https://stackoverflow.com/a/57659371 and other answers to that question)
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
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
      // item is specified by id, with optional id: prefix to be dropped
      const index = indexFromId.get(name.startsWith("id:") ? name.substring(3) : name);
      if (index === undefined) {
        console.error(`_item '${name}' not found`);
        return null;
      }
      item = items[index];
    }
    return Object.freeze(new _Item(item.id)); // defined below
  }

  // same as _item, but for existence checks, and allows multiple matches
  function _exists(name: string, allow_multiple = true): any {
    if (!name) return false;
    if (name.startsWith("#")) {
      // label
      const ids = idsFromLabel.get(name.toLowerCase());
      return allow_multiple ? ids?.length > 0 : ids?.length == 1;
    } else {
      // id
      const index = indexFromId.get(name.startsWith("id:") ? name.substring(3) : name);
      return index !== undefined;
    }
  }

  // _items returns any number of matches, most recent first
  function _items(label: string = "") {
    const ids = (label ? idsFromLabel.get(label.toLowerCase()) : items.map((item) => item.id)) || [];
    return _.sortBy(ids.map(_item), (item) => -item.time);
  }

  // _modal shows a modal dialog
  function _modal(options) {
    return modal.show(options);
  }

  // _modal_close closes modal manually
  function _modal_close(options) {
    return modal.hide();
  }

  // _modal_update updates existing modal without closing it
  function _modal_update(options) {
    return modal.update(options);
  }

  // _delay is just setTimeout wrapped in a promise
  function _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    window["_exists"] = _exists;
    window["_modal"] = _modal;
    window["_modal_close"] = _modal_close;
    window["_modal_update"] = _modal_update;
    window["_delay"] = _delay;
    window["_update_dom"] = update_dom;
    window["_decrypt_item"] = decryptItem;
  }

  // private function for looking up item given its id
  // (throws "deleted" error if item has been deleted)
  function item(id: string) {
    const index = indexFromId.get(id);
    if (index === undefined) throw new Error(`item ${id} deleted`);
    return items[index];
  }

  const log_levels = ["debug", "info", "log", "warn", "error"];

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
      // NOTE: we return the super-container as it is available even when editing
      // return document.getElementById("item-" + this.id);
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
    // levels are listed below, default level ("info") excludes debug messages
    // since can be "run" (default), "eval", or any epoch time (same as Date.now)
    // item can be "self" (default), specific item name (label or id), or "any"
    get_log(options = {}) {
      let since = options["since"] || "run";
      if (since == "run") since = item(this.id).lastRunTime;
      else if (since == "eval") since = item(this.id).lastEvalTime;
      else if (typeof since != "number") {
        console.error(`get_log: invalid since time '${since}', should be "run", "eval", or number (ms since epoch)`);
        return [];
      }
      const level = log_levels.indexOf(options["level"] || "info");
      if (level < 0) {
        console.error(`get_log: invalid level '${options["level"]}', should be one of: ${log_levels}`);
        return [];
      }
      const name = options["item"] || "self";
      if (name != "self" && name != "any" && !item(name)) {
        console.error(`get_log: item '${name}' not found`);
        return [];
      }
      const filter = options["filter"];
      if (filter !== undefined && typeof filter != "function") {
        console.error(
          `get_log: invalid filter '${filter}', should be function(entry) and return true|false to accept|reject entries with fields {time,level,stack,type,text}`
        );
        return [];
      }
      let log = [];
      const filter_id = name == "self" ? this.id : name == "any" ? "" : item(name).id;
      for (let i = consoleLog.length - 1; i >= 0; --i) {
        const entry = consoleLog[i];
        if (entry.time < since) break;
        if (entry.level < level) continue;
        if (filter_id && !entry.stack.includes(filter_id)) continue;
        if (filter && !filter(entry)) continue;
        let prefix = entry.type == "log" ? "" : entry.type.toUpperCase() + ": ";
        if (prefix == "WARN: ") prefix = "WARNING: ";
        log.push(prefix + entry.text);
      }
      return log.reverse();
    }

    write(text: string, type: string = "_output") {
      text = typeof text == "string" ? text : "" + JSON.stringify(text);
      // confirm if write is too big
      const writeConfirmLength = 16 * 1024;
      if (text.length >= writeConfirmLength) {
        if (!confirm(`Write ${text.length} bytes (${type}) into ${this.name}?`)) return; // cancel write
      }
      // maintain selection on textarea if editing
      if (item(this.id)?.editing) {
        let textarea = textArea(item(this.id).index);
        let selectionStart = textarea.selectionStart;
        let selectionEnd = textarea.selectionEnd;
        tick().then(() => {
          let textarea = textArea(indexFromId.get(this.id));
          if (!textarea) return;
          textarea.selectionStart = selectionStart;
          textarea.selectionEnd = selectionEnd;
        });
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
        // if (!item(this.id)?.editing) saveItem(this.id);
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
          level: "info",
          type: "_log",
          item: "self",
        },
        item(this.id).log_options, // may be undefined
        options
      );
      this.write(this.get_log(options).join("\n"), options["type"]);
      if (options["type"] == "_log" || options["show_logs"]) this.show_logs();
    }

    write_log_any(options = {}) {
      return this.write_log(Object.assign({ item: "any" }, item(this.id).log_options, options));
    }

    show_logs(autohide_after: number = 15000) {
      itemShowLogs(this.id, autohide_after);
    }

    // "touches" item by updating its time
    // if save=false, change is not saved, a.k.a. "soft touch"
    touch(save = false) {
      item(this.id).time = Date.now();
      lastEditorChangeTime = 0; // force immediate update
      onEditorChange(editorText); // item time has changed
      if (save) saveItem(this.id);
    }

    // evaluates given code in context of this item
    eval(js: string = "", options: object = {}) {
      initItems(); // initialize items if not already done, usually due to macros at first render
      let prefix = options["exclude_prefix"]
        ? ""
        : this.read_deep(
            options["type"] || "js",
            // NOTE: by default, async deps are excluded unless async:true in options
            //       this affects ALL default eval, including e.g. 'macro_*' evals (see Item.svelte)
            //       notable exceptions are async 'run' and async 'command' evals
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
        evaljs = ["'use strict';undefined;", `const _id = '${this.id}';`, "const _this = _item(_id);", evaljs].join(
          "\n"
        );
      }

      // evaluate inline @{eval_macros}@
      let macroIndex = 0;
      const replaceMacro = (m, pfx, js) => {
        try {
          let out = this.eval(js, {
            trigger: "eval_macro_" + macroIndex++,
            exclude_prefix: true /* avoid infinite recursion */,
          });
          // If output is an item, read(*_macro) by default, where * is the prefix type
          // (using _macro suffix allow item to be a dependency without importing same code as prefix)
          if (out instanceof _Item) out = out.read_deep((options["type"] || "js") + "_macro");
          return pfx + out;
        } catch (e) {
          console.error(`eval_macro error in item ${this.label || "id:" + this.id}: ${e}`);
          throw e;
        }
      };
      // evaljs = evaljs.replace(/(^|[^\\])<<(.*?)>>/g, replaceMacro);
      evaljs = evaljs.replace(/(^|[^\\])@\{(.*?)\}@/g, replaceMacro);

      // replace any remaining $id, $hash, $deephash, just like in macros or _html(_*) blocks
      evaljs = evaljs.replace(/(^|[^\\])\$id/g, "$1" + this.id);
      evaljs = evaljs.replace(/(^|[^\\])\$hash/g, "$1" + this.hash);
      evaljs = evaljs.replace(/(^|[^\\])\$deephash/g, "$1" + this.deephash);
      if (options["cid"]) evaljs = evaljs.replace(/(^|[^\\])\$cid/g, "$1" + options["cid"]);

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
        update_dom().then(() =>
          Promise.resolve(async_func())
            .then((output) => {
              if (output !== undefined) this.write(output);
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
        );
      });
    }

    // invokes given (sync) function after pushing item onto stack
    // re-returns any return value, rethrows (after logging) any errors
    invoke(func) {
      evalStack.push(this.id);
      try {
        let out = func();
        // if function returns promise, attach it and set up default rejection handler
        if (out instanceof Promise) {
          out = this.attach(out).catch((e) => {
            console.error(e);
            invalidateElemCache(this.id);
          });
        }
        if (evalStack.pop() != this.id) console.error("invalid stack");
        return out;
      } catch (e) {
        console.error(e);
        invalidateElemCache(this.id);
        if (evalStack.pop() != this.id) console.error("invalid stack");
        throw e;
      }
    }

    // "attaches" given function or promise to item such that it will go through _this.invoke()
    // promises are wrapped to auto-attach any functions passed to then/catch/finally
    attach(thing: any) {
      if (thing instanceof Promise) {
        const promise = thing;
        const _item = this; // for use in functions below
        promise.then = function (onFulfilled, onRejected) {
          // if (!onRejected) onRejected = console.error; // log errors by default
          return _item.attach(Promise.prototype.then.call(this, _item.attach(onFulfilled), _item.attach(onRejected)));
        };
        // Promise.catch internally calls Promise.then(undefined, onRejected) so no need to double-wrap
        // promise.catch = function (onRejected) {
        //   return _item.attach(Promise.prototype.catch.call(this, _item.attach(onRejected)));
        // };
        promise.finally = function (onFinally) {
          return _item.attach(Promise.prototype.finally.call(this, _item.attach(onFinally)));
        };
        return promise;
      } else if (typeof thing == "function") {
        const func = thing;
        return function (...args) {
          this.invoke(() => func(...args));
        }.bind(this);
      } else {
        return thing; // return as is
      }
    }

    // dispatch = setTimeout on attached function
    dispatch(func, ms, ...args) {
      setTimeout(this.attach(func), ms, ...args);
    }

    // promise = new Promise attached (see above) to item
    // the given executor function (resolve[,reject])=>{} is also attached
    promise(func) {
      return this.attach(new Promise(this.attach(func)));
    }

    // resolve = same as Promise.resolve but with the returns promise attached
    resolve(thing) {
      return this.attach(Promise.resolve(thing));
    }

    // console logging functions pre-attached to this item
    debug(...args) {
      this.invoke(() => console.debug(...args));
    }
    info(...args) {
      this.invoke(() => console.info(...args));
    }
    log(...args) {
      this.invoke(() => console.log(...args));
    }
    warn(...args) {
      this.invoke(() => console.warn(...args));
    }
    error(...args) {
      this.invoke(() => console.warn(...args));
    }

    // delay = promise resolved after specified time
    delay(ms) {
      return this.promise((resolve) => setTimeout(resolve, ms));
    }

    // return array of uploaded image srcs, urls ({output:"url"}), or blobs ({output:"blob"})
    // returns promise for urls or blobs as they require download and decryption
    images(options = {}) {
      let srcs = _.uniq(
        Array.from(
          (this.text
            .replace(/(?:^|\n) *```.*?\n *```/gs, "") // remove multi-line blocks
            // NOTE: currently we miss indented blocks that start with bullets -/* (since it requires context)
            .replace(/(?:^|\n)     *[^\-\*].*(?:$|\n)/g, "") // remove 4-space indented blocks
            .replace(/(^|[^\\])`.*?`/g, "$1") as any).matchAll(/<img .*?src\s*=\s*"(.*?)".*?>/gi),
          (m) => m[1]
        ).map((src) =>
          src.replace(/^https?:\/\/www\.dropbox\.com/, "https://dl.dropboxusercontent.com").replace(/\?dl=0$/, "")
        )
      ).filter((src) => src.match(/^\d+$/) || src.startsWith(user.uid + "/images/"));
      const output = options["output"] || "src";
      if (!["src", "url", "blob"].includes(output)) {
        console.error(`images: invalid output '${output}', should be src, url, or blob`);
        return srcs;
      }
      if (output == "src") return srcs;
      return Promise.all(
        srcs.map((src) => {
          if (src.match(/^\d+$/)) src = user.uid + "/images/" + src; // prefix {uid}/images/ automatically
          return new Promise((resolve, reject) => {
            if (images.has(src)) {
              // already available locally, convert to blob
              const url = images.get(src);
              if (output == "url") {
                resolve(url);
                return;
              }
              let start = Date.now();
              let xhr = new XMLHttpRequest();
              xhr.responseType = "blob";
              xhr.onload = (event) => {
                const blob = xhr.response;
                console.debug(`retrieved image ${src} (${blob.type}, ${blob.size} bytes) in ${Date.now() - start}ms`);
                resolve(blob);
              };
              xhr.onerror = console.error;
              xhr.open("GET", url);
              xhr.send();
              return;
            }
            const ref = firebase().storage().ref().child(src);
            ref
              .getDownloadURL()
              .then((url) => {
                let start = Date.now();
                let xhr = new XMLHttpRequest();
                xhr.responseType = "blob";
                xhr.onload = (event) => {
                  const blob = xhr.response;
                  console.debug(
                    `downloaded image ${src} (${blob.type}, ${blob.size} bytes) in ${Date.now() - start}ms`
                  );
                  if (src.startsWith("anonymous/")) {
                    resolve(output == "blob" ? blob : URL.createObjectURL(blob));
                    return;
                  }
                  start = Date.now();
                  const reader = new FileReader();
                  reader.readAsBinaryString(blob);
                  reader.onload = (e) => {
                    const cipher = e.target.result as string;
                    decrypt(cipher)
                      .then((str) => {
                        const type = str.substring(0, str.indexOf(";"));
                        str = str.substring(str.indexOf(";") + 1);
                        console.debug(
                          `decrypted image ${src} (${type}, ${str.length} bytes) in ${Date.now() - start}ms`
                        );
                        const array = new Uint8Array(
                          [].map.call(str, function (x) {
                            return x.charCodeAt(0);
                          })
                        );
                        const blob = new Blob([array], { type: type });
                        resolve(output == "blob" ? blob : URL.createObjectURL(blob));
                      })
                      .catch((e) => {
                        console.error(e);
                        reject(e);
                      });
                  };
                  reader.onerror = console.error;
                };
                xhr.onerror = console.error;
                xhr.open("GET", url);
                xhr.send();
              })
              .catch((e) => {
                console.error(e);
                reject(e);
              });
          });
        })
      );
    }

    // invalidate element cache for item
    invalidate_cache() {
      invalidateElemCache(this.id);
    }
  }

  function itemTimeString(time: number, round_up = false) {
    const round = round_up ? Math.ceil : Math.floor;
    time = (Date.now() - time) / 1000;
    if (time < 60) return round_up ? "1m" : "now";
    if (time < 3600) return round(time / 60).toString() + "m";
    if (time < 24 * 3600) return round(time / 3600).toString() + "h";
    return round(time / (24 * 3600)).toString() + "d";
  }

  function resizeHiddenColumn() {
    // programmatically size hidden column to match first column
    if (document.querySelector(".column.hidden"))
      (document.querySelector(".column.hidden") as HTMLElement).style.width =
        (document.querySelector(".column:not(.hidden)") as HTMLElement).offsetWidth + "px";
  }

  let indexFromId;
  let headerdiv;
  let consolediv;
  let dotCount = 0;
  let columnCount = 0;
  let topMovers = [];
  let toggles = [];
  let newestTime = 0;
  let oldestTime = Infinity;
  let oldestTimeString = "";
  let defaultHeaderHeight = 0;
  // TODO: try maxColumns=1 during initial render if partial-height layouts prove problematic
  let defaultItemHeight = 0; // if zero, initial layout will be single-column
  let totalItemHeight = 0;
  let lastLayoutTime = 0;
  let lastTimeStringUpdateTime = 0;
  let showDotted = false;

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
    let columnLastItem = new Array(columnCount).fill(-1);
    let columnItemCount = new Array(columnCount).fill(0);
    columnHeights[0] = headerdiv ? headerdiv.offsetHeight : defaultHeaderHeight; // first column includes header
    // reset topMovers if number of columns changes
    if (topMovers.length != columnCount) topMovers = new Array(columnCount).fill(items.length);
    let lastTimeString = "";
    newestTime = 0;
    oldestTime = Infinity;
    oldestTimeString = "";
    totalItemHeight = 0;
    lastLayoutTime = Date.now();
    lastTimeStringUpdateTime = Date.now();
    // showDotted = false; // auto-hide dotted
    resizeHiddenColumn();

    items.forEach((item, index) => {
      item.index = index;
      indexFromId.set(item.id, index);
      if (item.dotted) dotCount++;
      if (item.editing) editingItems.push(index);
      if (item.dotted && item.editing) showDotted = true;
      if (item.focused) focusedItem = index;

      let lastItem = items[index - 1];
      let timeString = itemTimeString(item.time);
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
          // NOTE: we include .section-separator height but ignore show which is dynamic (like dotted items)
          columnHeights[lastColumn] += 40; // .section-separator height including margins
        }
      }
      // mark item as aboveTheFold if it is pinned or item is visible on first screen
      // if item heights are not available, then we use item index in column and assume top 5 are above fold
      item.aboveTheFold =
        item.pinned ||
        (totalItemHeight > 0 ? columnHeights[item.column] < outerHeight : columnItemCount[item.column] < 5);
      // // item "prominence" i position in screen heights, always 0 if pinned, 1+ if !aboveTheFold
      // item.prominence = item.pinned
      //   ? 0
      //   : totalItemHeight > 0
      //   ? columnHeights[item.column] / outerHeight
      //   : columnItemCount[item.column] / 5;
      // columnItemCount[item.column]++;

      // mark item as "mover" if it changes index and/or column
      item.mover = item.index != item.lastIndex || item.column != item.lastColumn;
      if (item.mover && index < topMovers[item.column]) topMovers[item.column] = index;
      item.lastIndex = item.index;
      item.lastColumn = item.column;

      // if non-dotted item is first in its column or section and missing time string, add it now
      // also mark it as a "leader" for styling its index number
      item.leader = !item.dotted && (columnLastItem[item.column] < 0 || item.column != lastItem.column);
      if (item.leader && !item.timeString) {
        item.timeString = timeString;
        lastTimeString = timeString; // for grouping of subsequent items
        // add time string height now, assuming we are not ignoring item height
        if (item.outerHeight > 0) item.outerHeight += 24;
      }
      columnHeights[item.column] += item.outerHeight;
      if (columnLastItem[item.column] >= 0) {
        items[columnLastItem[item.column]].nextItemInColumn = index;
        // if item is below section-separator and has timeString, discount -24px negative margin
        if (columnLastItem[item.column] != index - 1 && item.timeString) columnHeights[item.column] -= 24;
      }
      columnLastItem[item.column] = index;
    });

    if (narrating) return;

    // trigger scroll up if needed to keep top movers visible
    if (_.min(topMovers) < items.length) {
      const lastLayoutTimeAtDispatch = lastLayoutTime; // so we update only for latest layout
      tick()
        .then(update_dom)
        .then(() => {
          if (lastLayoutTime != lastLayoutTimeAtDispatch) return; // cancelled
          const itemTop = _.min(
            topMovers.map((index) => {
              if (index == items.length) return Infinity; // nothing in this column
              const div = document.querySelector("#super-container-" + items[index].id);
              if (!div) return Infinity; // item hidden, have to ignore
              return (div as HTMLElement).offsetTop;
            })
          );
          // console.log(itemTop, document.body.scrollTop, topMovers.toString());
          if (itemTop - 100 < document.body.scrollTop) document.body.scrollTo(0, Math.max(0, itemTop - 100));
          topMovers = new Array(columnCount).fill(items.length); // reset topMovers after scroll
        });
    }
  }

  let images = new Map<string, string>(); // permanent fname to temporary url

  function onPastedImage(url: string, file: File, size_handler = null) {
    console.debug("pasted image", url);
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsBinaryString(file);
      reader.onload = (e) => {
        let str = e.target.result as string;
        if (size_handler) size_handler(str.length);
        const hash = hashCode(str).toString();
        const fname = `${user.uid}/images/${hash}`; // short fname is just hash
        if (readonly) images.set(fname, url); // skip upload
        if (images.has(fname)) {
          resolve(hash);
          return;
        }
        if (anonymous) {
          // console.debug(`uploading image ${fname} (${str.length} bytes) ...`);
          const ref = firebase().storage().ref().child(`${user.uid}/images/${hash}`);
          ref
            .put(file) // gets mime type from file.type
            .then((snapshot) => {
              console.debug(`uploaded image ${fname} (${str.length} bytes) in ${Date.now() - start}ms`);
              images.set(fname, url);
              resolve(hash);
            })
            .catch((e) => {
              console.error(e);
              reject(e);
            });
        } else {
          encrypt(file.type + ";" + str)
            .then((cipher) => {
              // console.debug(
              //   `uploading encrypted image ${fname} (${cipher.length} bytes, ${str.length} original) ...`
              // );
              const ref = firebase().storage().ref().child(`${user.uid}/images/${hash}`);
              ref
                .putString(cipher)
                .then((snapshot) => {
                  console.debug(
                    `uploaded encrypted image ${fname} (${cipher.length} bytes) in ${Date.now() - start}ms`
                  );
                  images.set(fname, url);
                  resolve(hash);
                })
                .catch((e) => {
                  console.error(e);
                  reject(e);
                });
            })
            .catch(console.error);
        }
      };
      reader.onerror = (e) => {
        console.error(e);
        reject(e);
      };
    });
  }

  function onImageRendering(src: string): string {
    if (src.match(/^\d+$/)) src = user.uid + "/images/" + src; // prefix {uid}/images/ automatically
    if (!src.startsWith(user.uid + "/images/") && !src.startsWith("anonymous/images/")) return src; // external image
    if (src.match(/^\d+$/)) src = user.uid + "/images/" + src; // prefix {uid}/images/ automatically
    if (images.has(src)) return images.get(src); // image ready
    return "/loading.gif"; // image must be loaded
  }

  function onImageRendered(img: HTMLImageElement) {
    // console.debug("image rendered", img.src);
    if (!img.hasAttribute("_src")) return Promise.resolve(); // nothing to do
    let src = img.getAttribute("_src");
    if (src.match(/^\d+$/)) src = user.uid + "/images/" + src; // prefix {uid}/images/ automatically
    if (images.has(src)) {
      if (img.src != images.get(src)) img.src = images.get(src);
      img.removeAttribute("_loading");
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      // image must be downloaded and decrypted if user is not anonymous
      const ref = firebase().storage().ref().child(src);
      ref
        .getDownloadURL()
        .then((url) => {
          if (src.startsWith("anonymous/")) {
            img.src = url;
            img.removeAttribute("_loading");
            resolve(img.src);
          } else {
            // download data
            const start = Date.now();
            // console.debug(`downloading encrypted image ${src} ...`);
            let xhr = new XMLHttpRequest();
            xhr.responseType = "blob";
            xhr.onload = (event) => {
              const blob = xhr.response;
              const reader = new FileReader();
              reader.readAsBinaryString(blob);
              reader.onload = (e) => {
                const cipher = e.target.result as string;
                decrypt(cipher)
                  .then((str) => {
                    const type = str.substring(0, str.indexOf(";"));
                    str = str.substring(str.indexOf(";") + 1);
                    console.debug(
                      `downloaded encrypted image ${src} (${type}, ${str.length} bytes) in ${Date.now() - start}ms`
                    );
                    const array = new Uint8Array(
                      [].map.call(str, function (x) {
                        return x.charCodeAt(0);
                      })
                    );
                    img.src = URL.createObjectURL(new Blob([array], { type: type }));
                    img.removeAttribute("_loading");
                    resolve(img.src);
                  })
                  .catch((e) => {
                    console.error(e);
                    reject(e);
                  });
              };
              reader.onerror = console.error;
            };
            xhr.onerror = console.error;
            xhr.open("GET", url);
            xhr.send();
          }
        })
        .catch((e) => {
          console.error(e);
          reject(e);
        });
    });
  }
  if (isClient) window["_onImageRendered"] = onImageRendered;

  function onEditorFocused(focused: boolean) {}

  function isSpecialTag(tag) {
    return (
      tag == "#log" ||
      tag == "#menu" ||
      tag == "#context" ||
      tag == "#init" ||
      tag == "#welcome" ||
      tag == "#listen" ||
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
    else if (tag == "#welcome") return ["#features/_welcome"];
    else if (tag == "#listen") return ["#features/_listen"];
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

  // NOTE: Invoke onEditorChange only editor text and/or item content has changed.
  //       Invoke updateItemLayout directly if only item sizes have changed.
  const sessionTime = Date.now();
  const editorDebounceTime = 500;
  let lastEditorChangeTime = 0;
  let matchingItemCount = 0;
  let textLength = 0;
  let editorChangePending = false;
  let forceNewStateOnEditorChange = false;
  let finalizeStateOnEditorChange = false;
  let replaceStateOnEditorChange = false;
  let ignoreStateOnEditorChange = false;
  let hideIndex = 0;
  let hideIndexFromRanking = 0;
  let hideIndexForSession = 0;

  function onEditorChange(text: string) {
    editorText = text; // in case invoked without setting editorText

    // editor text is considered "modified" and if there is a change from sessionHistory OR from history.state, which works for BOTH for debounced and non-debounced updates; this is used to enable/disable hiding (hideIndex decrease)
    const editorTextModified = text != sessionHistory[sessionHistoryIndex] || text != history.state.editorText;

    // keep history entry 0 updated, reset index on changes
    // NOTE: these include rapid changes, unlike e.g. history.state.editorText, but not debounces (editorText has already changed)
    if (text != sessionHistory[sessionHistoryIndex]) {
      sessionHistoryIndex = 0;
      if (sessionHistory.length == 0) sessionHistory = [text];
      else sessionHistory[0] = text;
      // update highlighting state used in Item.svelte
      window["_mindboxLastModified"] = Date.now();
      window["_mindboxDebounced"] = true;
      window["_highlight_counts"] = {};
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
    window["_mindboxDebounced"] = false;
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
    let targetItemCount = 0;
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
      context = [item.label].concat(item.labelPrefixes); // lower index means lower in ranking
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
            // NOTE: "context of context" should be at the end (top), so we do difference + concat
            if (ctxitem.labelPrefixes.length > 0)
              context = _.difference(context, ctxitem.labelPrefixes).concat(ctxitem.labelPrefixes);
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

      // match query terms against item label
      item.labelMatch = terms.includes(item.label);

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
              item.dependentsString.toLowerCase().includes(t)
          ),
          terms.filter(
            (t) => item.depsString.toLowerCase().includes(t) || item.dependentsString.toLowerCase().includes(t)
          )
        )
      );

      // item is considered matching if primary terms match
      // (i.e. secondary terms are used only for ranking and highlighting matching tag prefixes)
      // (this is consistent with .index.matching in Item.svelte)
      item.matching = item.matchingTerms.length > 0;
      if (item.matching) matchingItemCount++;

      // listing item and id-matching items are considered "target" items
      item.target = listingItemIndex == index || idMatchTerms.length > 0;
      item.target_context = !item.target && context.includes(item.uniqueLabel);
      if (item.target) targetItemCount++;

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
    if (listingItemIndex >= 0 && !items[listingItemIndex].log) items[listingItemIndex].time = now + 2; // prioritize

    // Update times for id-matching items (but not save yet, a.k.a. "soft touch")
    idMatchItemIndices.forEach((index) => {
      if (!items[index].log) items[index].time = now + 1; // prioritize
    });

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
      time: now + 1000 /* dominate any offsets used above */,
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
    items = items.sort(
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
    );

    // determine "tail" index after which items are ordered purely by time
    // (also including editing log items which are edited in place)
    let tailIndex = items.findIndex((item) => item.id === null);
    items.splice(tailIndex, 1);
    tailIndex = Math.max(tailIndex, _.findLastIndex(items, (item) => item.editing) + 1);
    let tailTime = items[tailIndex]?.time || 0;
    hideIndexFromRanking = tailIndex;
    const prevHideIndex = hideIndex; // to possibly take max later (see below)
    hideIndex = hideIndexFromRanking;

    // update layout (used below, e.g. aboveTheFold, editingItems, etc)
    updateItemLayout();
    lastEditorChangeTime = Infinity; // force minimum wait for next change

    // determine "toggle" indices (ranges) where item visibility can be toggled
    toggles = [];

    // when hideIndexFromRanking is large, we use position-based toggle points to reduce unnecessary computation
    let unpinnedIndex = _.findLastIndex(items, (item) => item.pinned || item.editing || item.target) + 1;
    let belowFoldIndex = _.findLastIndex(items, (item) => item.aboveTheFold || item.editing || item.target) + 1;
    if (unpinnedIndex < Math.min(belowFoldIndex, hideIndexFromRanking)) {
      toggles.push({
        start: unpinnedIndex,
        end: Math.min(belowFoldIndex, hideIndexFromRanking),
        positionBased: true,
      });
    }
    if (belowFoldIndex < hideIndexFromRanking) {
      let lastToggleIndex = belowFoldIndex;
      [10, 30, 50, 100, 200, 500, 1000].forEach((toggleIndex) => {
        if (lastToggleIndex >= hideIndexFromRanking) return;
        toggles.push({
          start: lastToggleIndex,
          end: Math.min(belowFoldIndex + toggleIndex, hideIndexFromRanking),
          positionBased: true,
        });
        lastToggleIndex = belowFoldIndex + toggleIndex;
      });
    }

    // ensure contiguity of position-based toggles up to hideIndexFromRanking
    if (toggles.length > 0) toggles[toggles.length - 1].end = hideIndexFromRanking;

    // merge position-based toggles smaller than 10 indices
    for (let i = 1; i < toggles.length; i++) {
      if (toggles[i - 1].end - toggles[i - 1].start < 10 || toggles[i].end - toggles[i].start < 10) {
        toggles[i - 1].end = toggles[i].end;
        toggles.splice(i--, 1); // merged into last
      }
    }

    // first time-based toggle point is the "session toggle" for items "touched" in this session (since first ranking)
    // NOTE: there is a difference between soft and hard touched items: soft touched items can be hidden again by going back (arguably makes sense since they were created by soft interactions such as navigation and will go away on reload), but hard touched items can not, so they are "sticky" in that sense.
    hideIndexForSession = Math.max(hideIndexFromRanking, _.findLastIndex(items, (item) => item.time > sessionTime) + 1);
    // auto-show session items if no position-based toggles
    // otherwise show first position-based toggle, unless there are targets
    if (toggles.length == 0) hideIndex = hideIndexForSession;
    else hideIndex = targetItemCount > 0 ? toggles[0].start : toggles[0].end;
    // if editor text is not modified, we can only show more items
    if (!editorTextModified) hideIndex = Math.max(hideIndex, prevHideIndex);

    if (hideIndexForSession > hideIndexFromRanking && hideIndexForSession < items.length) {
      toggles.push({
        start: hideIndexFromRanking,
        end: hideIndexForSession,
      });
      tailIndex = hideIndexForSession;
      tailTime = items[hideIndexForSession].time;
    }

    // add toggle points for "extended tail times"
    // NOTE: we do this by time to help avoid big gaps in time (that cross these thresholds)
    [1, 3, 7, 14, 30].forEach((daysAgo) => {
      const extendedTailTime = Date.now() - daysAgo * 24 * 3600 * 1000;
      if (extendedTailTime > tailTime) return;
      const extendedTailIndex =
        tailIndex + items.slice(tailIndex).filter((item) => item.time >= extendedTailTime).length;
      if (extendedTailIndex <= tailIndex || extendedTailIndex >= items.length) return;
      toggles.push({
        start: tailIndex,
        end: extendedTailIndex,
      });
      tailIndex = extendedTailIndex;
      tailTime = items[extendedTailIndex].time;
    });
    // add final toggle point for all items
    if (tailIndex < items.length) {
      toggles.push({
        start: tailIndex,
        end: items.length,
      });
    }
    // console.debug(toggles);

    if (!ignoreStateOnEditorChange) {
      // update history, replace unless current state is final (from tag click)
      const orderHash = hashCode(items.map((item) => item.id).join());
      if (editorText != history.state.editorText || orderHash != history.state.orderHash) {
        // need to update history
        const state = {
          editorText,
          unsavedTimes: items.filter((item) => item.time != item.savedTime).map((item) => _.pick(item, ["id", "time"])),
          orderHash,
          hideIndex,
          scrollPosition: document.body.scrollTop,
          final: !editorText || finalizeStateOnEditorChange,
        };
        // console.debug(history.state.final ? "push" : "replace", state);
        if (forceNewStateOnEditorChange || (history.state.final && !replaceStateOnEditorChange))
          history.pushState(state, editorText);
        else history.replaceState(state, editorText);
      }
    }
    forceNewStateOnEditorChange = false; // processed above
    finalizeStateOnEditorChange = false; // processed above
    replaceStateOnEditorChange = false; // processed above
    ignoreStateOnEditorChange = false; // processed above

    // invoke _on_search on all _listen items
    setTimeout(() => {
      items.forEach((item) => {
        if (!item.listen) return;
        try {
          _item(item.id).eval(`_on_search(\`${editorText.replace(/`/g, "\\`")}\`)`, { trigger: "listen" });
        } catch (e) {} // already logged, just continue
      });
    });

    if (Date.now() - start >= 250) console.warn("onEditorChange took", Date.now() - start, "ms");
  }

  function toggleItems(index: number) {
    hideIndex = index;
    history.replaceState(Object.assign(history.state, { hideIndex }), editorText);
  }

  function onTagClick(id: string, tag: string, reltag: string, e: MouseEvent) {
    const index = indexFromId.get(id);
    if (index === undefined) return; // deleted
    // "soft touch" item if not already newest and not pinned and not log
    if (items[index].time > newestTime) console.warn("invalid item time");
    else if (items[index].time < newestTime && !items[index].pinned && !items[index].log)
      items[index].time = Date.now();
    // console.debug(e.pageX, e.pageY, document.documentElement.scrollLeft, document.documentElement.scrollTop);

    // NOTE: Rendered form of tag should be renderTag(reltag). We use common suffix to map click position.
    const rendered = renderTag(reltag);
    let suffix = rendered;
    while (!tag.endsWith(suffix)) suffix = suffix.substring(1);
    let prefix_click = false;
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
        prefix_click = pos > 1 && pos <= tag.length - suffix.length;
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

    if (editorText.trim().toLowerCase() == tag.toLowerCase()) {
      if (prefix_click) {
        // assuming trying to go to a parent/ancestor
        alert(`${tag} already selected`);
        return;
      } else editorText = ""; // assume intentional toggle
    } else {
      editorText = tag + " "; // space in case more text is added
    }
    forceNewStateOnEditorChange = true; // force new state
    finalizeStateOnEditorChange = true; // finalize state
    tick().then(() => editor.setSelection(editorText.length, editorText.length));
    lastEditorChangeTime = 0; // disable debounce even if editor focused
    onEditorChange(editorText);

    if (narrating) return;
    // scroll up (or down) to target item if needed
    if (items.findIndex((item) => item.target) >= 0) {
      tick()
        .then(update_dom)
        .then(() => {
          let topTargets = new Array(columnCount).fill(items.length);
          items.forEach((item, index) => {
            if (item.target && index < topTargets[item.column]) topTargets[item.column] = index;
          });
          const itemTop = _.min(
            topTargets.map((index) => {
              if (index == items.length) return Infinity; // nothing in this column
              const div = document.querySelector("#super-container-" + items[index].id);
              if (!div) return Infinity; // item hidden, have to ignore
              return (div as HTMLElement).offsetTop;
            })
          );
          if (itemTop == Infinity) return; // nothing to scroll to
          // if item is too far up, or too far down, bring it to ~middle of page
          if (itemTop - 100 < document.body.scrollTop || itemTop + 100 > document.body.scrollTop + innerHeight)
            document.body.scrollTo(0, Math.max(0, itemTop - innerHeight / 2));
        });
    }
  }

  function onLinkClick(id: string, href: string, e: MouseEvent) {
    const index = indexFromId.get(id);
    if (index === undefined) return; // deleted
    // "soft touch" item if not already newest and not pinned and not log
    if (items[index].time > newestTime) console.warn("invalid item time");
    else if (items[index].time < newestTime && !items[index].pinned && !items[index].log) {
      items[index].time = Date.now();
      onEditorChange(editorText); // item time has changed
    }
  }

  function onLogSummaryClick(id: string) {
    let index = indexFromId.get(id);
    if (index === undefined) return;
    items[index].showLogs = !items[index].showLogs;
    items[index].showLogsTime = Date.now(); // invalidates auto-hide
  }

  function onPopState(e) {
    readonly = anonymous && !admin;
    if (!e?.state) return; // for fragment (#id) hrefs
    if (!initialized) {
      // NOTE: this can happen when tab is restored, seems harmless so far
      // console.warn("onPopState before init");
      return;
    }
    // console.debug("onPopState", e.state);
    // restore editor text and unsaved times
    editorText = e.state.editorText || "";
    if (e.state.unsavedTimes) {
      items.forEach((item) => (item.time = item.savedTime));
      e.state.unsavedTimes.forEach((entry) => {
        const index = indexFromId.get(entry.id);
        if (index === undefined) return; // item was deleted
        items[index].time = entry.time;
      });
    }
    lastEditorChangeTime = 0; // disable debounce even if editor focused
    ignoreStateOnEditorChange = true; // do not update history when going back
    onEditorChange(editorText);
    // restore (lower) hide index _after_ onEditorChange which sets it to default index given query
    if (typeof e.state.hideIndex == "number") hideIndex = Math.max(hideIndex, e.state.hideIndex);
    // if (narrating) return;
    // scroll to last recorded scroll position at this state
    tick()
      .then(update_dom)
      .then(() => document.body.scrollTo(0, e.state.scrollPosition || 0));
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

    // blur active element as caret can show through loading div
    // (can require dispatch on chrome if triggered from active element)
    setTimeout(() => (document.activeElement as HTMLElement).blur());

    localStorage.removeItem("mindpage_secret"); // also remove secret when signing out
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
    item.runnable = item.lctext.match(/\s*```\w+_input(?:_hidden|_removed)?(?:\s|$)/);
    item.scripted = item.lctext.match(/<script.*?>/);
    item.macroed = item.lctext.match(/<<.*?>>/) || item.lctext.match(/@\{.*?\}@/);

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
    item.welcome = item.tagsRaw.includes("#_welcome");
    item.listen = item.tagsRaw.includes("#_listen");
    item.async = item.tagsRaw.includes("#_async");
    item.debug = item.tagsRaw.includes("#_debug");
    const pintags = item.tagsRaw.filter((t) => t.match(/^#_pin(?:\/|$)/));
    item.pinned = pintags.length > 0;
    item.pinTerm = pintags[0] || "";
    item.dotted = pintags.findIndex((t) => t.match(/^#_pin\/dot(?:\/|$)/)) >= 0;
    item.dotTerm = pintags.filter((t) => t.match(/^#_pin\/dot(?:\/|$)/))[0] || "";

    // if item stats with visible #tag, it is taken as a "label" for the item
    // (we allow some html tags/macros to precede the label tag for styling purposes)
    const prevLabel = item.label;
    item.header = item.lctext.replace(/^<.*>\s+#/, "#").match(/^.*?(?:\n|$)/)[0];
    item.label = item.header.startsWith(item.tagsVisible[0]) ? item.tagsVisible[0] : "";
    item.labelText = item.label ? item.text.replace(/^<.*>\s+#/, "#").match(/^#\S+/)[0] : "";
    if (item.labelUnique == undefined) item.labelUnique = false;
    if (item.labelPrefixes == undefined) item.labelPrefixes = [];
    if (item.label) {
      // convert relative tags to absolute
      const resolveTag = (tag) =>
        tag.startsWith("#//")
          ? item.label.replace(/\/[^\/]*$/, "") + tag.substring(2)
          : tag.startsWith("#/")
          ? item.label + tag.substring(1)
          : tag;
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
        if (ids.length == 1) {
          let other = items[indexFromId.get(ids[0])];
          other.labelUnique = true;
          other.name = other.labelUnique ? other.labelText : "id:" + other.id;
        }
      }
      if (item.label) {
        const ids = (idsFromLabel.get(item.label) || []).concat(item.id);
        idsFromLabel.set(item.label, ids);
        item.labelUnique = ids.length == 1;
        if (ids.length == 2) {
          let other = items[indexFromId.get(ids[0])];
          other.labelUnique = false;
          other.name = other.labelUnique ? other.labelText : "id:" + other.id;
        }
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
            password: true,
            username: user.email,
            autocomplete: "new-password",
          });
        }
        if (phrase == null) break;
        confirmed = await modal.show({
          content: "Confirm your new secret phrase:",
          confirm: "Confirm",
          cancel: "Sign Out",
          input: "",
          password: true,
          username: user.email,
          autocomplete: "new-password",
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
        password: true,
        username: user.email,
        autocomplete: "current-password",
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
  let editor;
  function onEditorDone(text: string, e: any = null, cancelled: boolean = false, run: boolean = false, editing = null) {
    editorText = text; // in case invoked without setting editorText
    const key = e?.code || e?.key;
    if (cancelled) {
      if (key == "Escape") {
        setTimeout(() => textArea(-1).blur()); // requires dispatch on chrome
      } else {
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange("");
      }
      return;
    }

    // reset history index, update entry 0 and unshift duplicate entry
    // NOTE: we do not depend on onEditorChange keeping entry 0 updated, even though it should
    // NOTE: if event (e) is missing, this is considered a "synthetic" call not added to history
    // NOTE: if new entry would be blank or same as previous, we do not create a new entry
    if (e) {
      sessionHistoryIndex = 0;
      if (sessionHistory[0] != text.trim()) {
        if (sessionHistory.length == 0) sessionHistory = [text.trim()];
        else sessionHistory[0] = text.trim();
      }
      if (sessionHistory[0].trim() && (sessionHistory.length == 1 || sessionHistory[0] != sessionHistory[1]))
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
    // force editing if text is empty
    if (!text.trim()) editing = true;

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
          .then((doc) => onEditorDone(doc.data().text))
          .catch(console.error);
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
        onEditorChange("");
        return;
      }
      case "/_green_screen": {
        window["_green_screen"] = green_screen = !green_screen;
        localStorage.setItem("mindpage_green_screen", green_screen ? "true" : "false");
        return;
      }
      default: {
        if (text.match(/^\/\w+/)) {
          const cmd = text.match(/^\/\w+/)[0];
          const args = text
            .replace(/^\/\w+/, "")
            .trim()
            .replace(/`/g, "\\`");
          if (cmd == "/_narrate") {
            narrating = !narrating;
            if (narrating) {
              localStorage.setItem("mindpage_narrating", args);
              localStorage.setItem("mindpage_green_screen", "true");
              window["_green_screen"] = green_screen = true;
            } else {
              const video = document.querySelector("#webcam-video") as HTMLVideoElement;
              if (video) {
                (video.srcObject as any)?.getTracks().forEach((track) => track.stop());
                video.srcObject = null;
              }
              localStorage.removeItem("mindpage_narrating");
            }
            lastEditorChangeTime = 0; // disable debounce even if editor focused
            onEditorChange("");
            return;
          } else if (cmd == "/_example") {
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
              const log = _item("#commands" + cmd).get_log({ since: "eval", level: "error" });
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
                    onEditorChange("");
                  } else if (typeof obj == "string") {
                    onEditorChange(obj);
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
                    let item = onEditorDone(text, null, false, run, editing);
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

    hideIndex++; // show one more item
    lastEditorChangeTime = 0; // disable debounce even if editor focused
    onEditorChange(editorText); // integrate new item at index 0

    if (run) {
      // NOTE: appendJSOutput can trigger _writes that trigger saveItem, which will be skip due to saveId being null
      appendJSOutput(indexFromId.get(item.id));
      text = itemToSave.text = item.text; // no need to update editorText
    }

    // maintain selection on created textarea if editing
    if (editing) {
      let textarea = textArea(-1);
      let selectionStart = textarea.selectionStart;
      let selectionEnd = textarea.selectionEnd;
      // for generated (vs typed) items, focus at the start for better context and no scrolling up
      if (text != origText) selectionStart = selectionEnd = 0;
      tick().then(() => {
        let textarea = textArea(indexFromId.get(item.id));
        if (!textarea) return;
        textarea.selectionStart = selectionStart;
        textarea.selectionEnd = selectionEnd;
        textarea.focus();
        // NOTE: on the iPad, there is an odd bug where a tap-to-click (but not a full click) on the trackpad on create button can cause a semi-focused state where activeElement has changed but the element does not show caret or accept input except some keys such as tab, AND selection reverts to 0/0 after ~100ms (as if something is momentarily clearing the textarea, perhaps due to some external keyboard logic), and we could not figure out any reason (it is not the editor's onMount or other places where selection is set) or other workaround (e.g. using other events to trigger onCreate), except to check for reversion to 0/0 after 100ms and fix if any
        if (selectionStart > 0 || selectionEnd > 0) {
          setTimeout(() => {
            if (textarea.selectionStart == 0 && textarea.selectionEnd == 0) {
              textarea.selectionStart = selectionStart;
              textarea.selectionEnd = selectionEnd;
            }
          }, 100);
        }
      });
    }

    // invoke _on_create on all _listen items
    setTimeout(() => {
      items.forEach((item) => {
        if (!item.listen) return;
        try {
          _item(item.id).eval(`_on_create(\`${text.replace(/`/g, "\\`")}\`)`, { trigger: "listen" });
        } catch (e) {} // already logged, just continue
      });
    });

    encryptItem(itemToSave)
      .then((itemToSave) => {
        (readonly
          ? Promise.resolve({ id: item.id, delete: Promise.resolve })
          : firestore().collection("items").add(itemToSave)
        )
          .then((doc) => {
            let index = indexFromId.get(item.id); // since index can change
            tempIdFromSavedId.set(doc.id, item.id);
            if (index == undefined) {
              // item was deleted before it could be saved
              doc.delete().catch(console.error);
              return;
            }
            item.savedId = doc.id;

            // if editing, we do not call onItemSaved so save is postponed to post-edit, and cancel = delete
            if (!item.editing) onItemSaved(item.id, itemToSave);

            // also save to history (using persistent doc.id) ...
            if (!readonly) {
              firestore()
                .collection("history")
                .add({ item: doc.id, ...itemToSave })
                .catch(console.error);
            }
          })
          .catch(console.error);
      })
      .catch(console.error);

    return _item(item.id); // return reference to created item
  }

  function focusOnNearestEditingItem(index: number) {
    // console.debug("focusOnNearestEditingItem", index, editingItems);
    let near = Math.min(...editingItems.filter((i) => i > index && i < hideIndex));
    if (near == Infinity) near = Math.max(...[-1, ...editingItems.filter((i) => i < hideIndex)]);
    focusedItem = near;
    if (near == -1) return; // do not auto-focus on editor
    tick().then(() => textArea(near).focus());
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

  function onItemEscape(e) {
    if (!editorText) return true; // not handled
    if (!e.shiftKey) return true; // not handled (want shift key also)
    editorText = "";
    forceNewStateOnEditorChange = true; // force new state
    finalizeStateOnEditorChange = true; // finalize state
    lastEditorChangeTime = 0; // disable debounce even if editor focused
    onEditorChange(editorText);
    // restore focus (can be necessary e.g. if edited item was also "target" item)
    const focusElement = document.activeElement as HTMLElement;
    setTimeout(() => focusElement.focus());
    return false; // escape handled
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
    if (prevHeight == 0) {
      if (height == 0) console.warn(`zero initial height for item ${item.name} at position ${index + 1}`);
      if (item.resolve_render) item.resolve_render(height);
      item.resolve_render = null;
    }
    if (height == prevHeight) return; // nothing has changed
    if (height == 0 && prevHeight > 0) {
      console.warn(`ignoring zero height (was ${prevHeight}) for item ${item.name} at position ${index + 1}`);
      return;
    }

    item.height = height;
    if (item.hidden) return; // skip layout update for hidden item

    // NOTE: Heights can fluctuate due to async scripts that generate div contents (e.g. charts), especially where the height of the output is not known and can not be specified via CSS, e.g. as an inline style on the div. We tolerate these changes for now, but if this becomes problematic we can skip or delay some layout updates, especially when the height is decreasing, postponing layout update to other events, e.g. reordering of items.
    if (
      height == 0 ||
      prevHeight == 0 ||
      Math.abs(height - prevHeight) > 300
      // height < 0.5 * prevHeight ||
      // height > prevHeight + 100
    ) {
      if (!layoutPending) {
        layoutPending = true;
        const tryLayout = () => {
          // NOTE: checking lastEditTime helps reduce editor issues (e.g. jumping of cursor) related to resizing while editing, but does NOT solve all issues, especially those not related to resizing.
          if (Date.now() - lastEditTime < 500 || Date.now() - lastScrollTime < 500) {
            // try again later
            setTimeout(tryLayout, 250);
            return;
          }
          updateItemLayout();
          layoutPending = false;
        };
        // if totalItemHeight == 0, then we have not yet done any layout with item heights available, so we do not want to delay too long, but just want to give it enough time for heights to be reasonably accurate
        setTimeout(tryLayout, totalItemHeight > 0 ? 250 : 50); // try now
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
    if (!item.runnable) return item.text; // item not runnable, ignore
    // check js_input
    const async = item.async || item.deps.map((id) => items[indexFromId.get(id)].async).includes(true);
    let jsin = extractBlock(item.text, "js_input");
    // if js_input block is missing entirely (not just empty), then evaluate "(return await) _run()"
    if (!jsin && !item.lctext.match(/\s*```js_input(?:_hidden|_removed)?(?:\s|$)/)) {
      jsin = async ? "return await _run()" : "_run()";
      jsin = `if (typeof _run === 'undefined') { console.error('_run undefined; enabling #_tag may be missing for *_input block (e.g. #_typescript for ts_input)') } else { ${jsin} }`;
    }
    if (!jsin) return item.text; // input missing or empty, ignore
    let jsout;
    try {
      jsout = _item(item.id).eval(jsin, { debug: item.debug, async, trigger: "run" /*|create*/ });
    } catch (e) {} // already logged, just continue
    // ignore output if Promise
    if (jsout instanceof Promise) jsout = undefined;
    const outputConfirmLength = 16 * 1024;
    if (jsout !== undefined && ("" + JSON.stringify(jsout)).length >= outputConfirmLength) {
      if (!confirm(`Write ${jsout.length} bytes (_output) into ${item.name}?`)) jsout = undefined;
    }
    // append _output and _log and update for changes
    if (jsout !== undefined) item.text = appendBlock(item.text, "_output", jsout);
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
  function isIOS() {
    if (typeof navigator == "undefined") return false;
    return (
      ["iPad Simulator", "iPhone Simulator", "iPod Simulator", "iPad", "iPhone", "iPod"].includes(navigator.platform) ||
      // iPad on iOS 13 detection
      (navigator.userAgent.includes("Mac") && "ontouchend" in document)
    );
  }
  // https://stackoverflow.com/a/6031480
  function isAndroid() {
    if (typeof navigator == "undefined") return false;
    return navigator.userAgent.toLowerCase().includes("android");
  }

  const android = isAndroid();
  const ios = isIOS();

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
      // if (ios) textArea(-1).focus(); // allows refocus outside of click handler
      tick().then(() => {
        if (!textArea(item.index)) {
          console.warn("missing editor");
          return;
        }
        textArea(item.index).focus();
      });
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
        if (index < hideIndex) hideIndex--; // back up hide index
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
        // if alt/option+cmd are held together, restore (i.e. do not modify) savedTime
        if (altKey && metaKey) item.time = item.savedTime;
        if (!cancelled && (item.time != item.savedTime || item.text != item.savedText)) saveItem(item.id);
        onEditorChange(editorText); // item time and/or text may have changed
      }

      // NOTE: we do not focus back up on the editor unless we are already at the top
      //       (especially bad on iphone due to lack of keyboard focus benefit)
      if (editingItems.length > 0 || document.body.scrollTop == 0) focusOnNearestEditingItem(index);
    }

    // scroll up to top of item if needed, allowing dom update before calculating new position
    // (particularly important for items that are much taller when editing)
    tick().then(() => {
      if (!narrating) {
        update_dom().then(() => {
          const div = document.querySelector("#super-container-" + item.id);
          if (!div) return; // item deleted or hidden
          const itemTop = (div as HTMLElement).offsetTop;
          if (itemTop - 100 < document.body.scrollTop) document.body.scrollTo(0, Math.max(0, itemTop - 100));
        });
      }
    });
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
    // maintain selection on textarea if editing
    if (item.editing) {
      let textarea = textArea(index);
      let selectionStart = textarea.selectionStart;
      let selectionEnd = textarea.selectionEnd;
      tick().then(() => {
        let textarea = textArea(indexFromId.get(item.id));
        if (!textarea) return;
        textarea.selectionStart = selectionStart;
        textarea.selectionEnd = selectionEnd;
      });
    }
    // clear *_output blocks as they should be re-generated
    item.text = clearBlock(item.text, "\\w*?_output");
    // remove *_log blocks so errors do not leave empty blocks
    item.text = removeBlock(item.text, "\\w*?_log");
    itemTextChanged(index, item.text); // updates tags, label, deps, etc before JS eval
    appendJSOutput(index);
    item.time = Date.now();
    // we now save even if editing, for consistency with write() saving during edit
    // if (!item.editing) saveItem(item.id);
    saveItem(item.id);
    lastEditorChangeTime = 0; // force immediate update (editor should not be focused but just in case)
    onEditorChange(editorText); // item time/text has changed
  }

  function onItemTouch(index: number) {
    // if (items[index].log) {
    //   alert("#log item can not be moved");
    //   return;
    // } // ignore
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
    // onEditorChange(""); // item time has changed, and editor cleared
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
    if (index === undefined) return;
    if (index >= hideIndex) return;
    if (items[index].editing) return;
    editItem(index);
    lastEditorChangeTime = 0; // force immediate update
    onEditorChange(editorText); // since edit state changed
    tick().then(() => {
      let index = indexFromId.get(lastEditItem);
      if (index === undefined) return;
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
        onEditorChange(sessionHistory[sessionHistoryIndex]);
        tick().then(() => {
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
      tick().then(() => textArea(index + inc).focus());
    }
  }

  function onNextItem(inc = 1) {
    if (sessionHistoryIndex > 0) {
      sessionHistoryIndex--;
      // console.debug("sessionHistoryIndex", sessionHistoryIndex);
      lastEditorChangeTime = 0; // disable debounce even if editor focused
      onEditorChange(sessionHistory[sessionHistoryIndex]);
      tick().then(() => {
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
    tick().then(() => textArea(index + inc).focus());
  }

  let lastScrollTime = 0;
  let historyUpdatePending = false;
  function onScroll() {
    lastScrollTime = Date.now();
    if (!historyUpdatePending) {
      historyUpdatePending = true;
      setTimeout(() => {
        // console.debug("updating history.state.scrollPosition", document.body.scrollTop);
        history.replaceState(Object.assign(history.state, { scrollPosition: document.body.scrollTop }), editorText);
        historyUpdatePending = false;
      }, 250);
    }
  }

  let lastResizeTime = 0;
  function onResize() {
    lastResizeTime = Date.now();
  }

  function onStatusClick(e) {
    // ignore click if text is selected
    if (window.getSelection().type == "Range") {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    if (showDotted && editingItems.map((index) => items[index].dotted).includes(true)) {
      alert("can not minimize items while editing");
      return;
    }
    showDotted = !showDotted;
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
        ? `${e.message}; STACK: ${e.stack.split(/\n\s*/g).join(", ")}`
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
    checkElemCache,
  } from "../util.js";

  let consoleLog = [];
  const consoleLogMaxSize = 10000;
  const statusLogExpiration = 15000;

  let itemInitTime = 0;
  function initItems() {
    if (itemInitTime) return; // already initialized items
    itemInitTime = Date.now();
    items.forEach((item) => {
      if (!item.init) return;
      try {
        _item(item.id).eval("_init()", {
          // if item has js_init block, use that, otherwise use js block without dependencies
          type: extractBlock(item.text, "js_init") ? "js_init" : "js",
          include_deps: false,
          trigger: "init",
        });
      } catch (e) {} // already logged, just continue init
    });
  }

  let initTime = 0; // set where initialize is invoked
  let processed = false;
  let initialized = false;
  let maxRenderedAtInit = 100;
  let adminItems = new Set(["QbtH06q6y6GY4ONPzq8N" /* welcome item */]);
  let resolve_init; // set below
  function init_log(...args) {
    console.debug(`[${Math.round(performance.now())}ms] ${args.join(" ")}`);
  }

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
      item.matching = false;
      item.target = false;
      item.target_context = false;
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
      item.aboveTheFold = false;
      // item.prominence = 0;
      item.leader = false;
      item.mover = false;
      item.timeString = "";
      item.timeOutOfOrder = false;
      item.height = 0;
      item.resolve_render = null; // invoked from onItemResized on first call
      item.column = 0;
      item.lastColumn = 0;
      item.nextColumn = -1;
      item.nextItemInColumn = -1;
      item.outerHeight = 0;
      // dependents (filled below)
      item.dependents = [];
      item.dependentsString = "";
      // other state
      item.lastEvalTime = 0; // used for _item.get_log
      item.lastRunTime = 0; // used for _item.get_log
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

    initItems();

    // if fragment corresponds to an item tag or id, focus on that item immediately ...
    if (items.length > 0 && location.href.match(/#.+$/)) {
      const tag = decodeURI(location.href.match(/#.+$/)[0]);
      // if it is a valid item id, then we convert it to name
      const index = indexFromId.get(tag.substring(1));
      if (index !== undefined) {
        replaceStateOnEditorChange = true; // replace state
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange(items[index].name);
      } else if (idsFromLabel.get(tag.toLowerCase())?.length == 1) {
        replaceStateOnEditorChange = true; // replace state
        lastEditorChangeTime = 0; // disable debounce even if editor focused
        onEditorChange(tag);
      }
    }

    processed = true;
    // init_log(`processed ${items.length} items`);

    // NOTE: last step in initialization is rendering, which is handled asynchronously by svelte and considered completed when onItemResized is invoked for each item (zero heights are logged as warning); we support initialization in chunks, but it seems background rendering can make rendered items unresponsive (even if done in small chunks with large intervals), so best option may be to have a hard truncation point to limit initialization time -- the downside of uninitialized items is that their heights are not known until they are rendered

    const unpinnedIndex = _.findLastIndex(items, (item) => item.pinned) + 1;
    await renderRange(
      0,
      unpinnedIndex /*initial chunk*/,
      10 /*chunk*/,
      maxRenderedAtInit /*cutoff*/,
      100 /*delay*/
    ).then(() => {
      init_log(`initialized ${items.length} items`);
      initialized = true;
      resolve_init();
    });
  }

  let rendered = false;
  let renderStart = 0;
  let renderEnd = 0;
  let keepOnPageDuringDelay = false;

  function renderRange(start, end, chunk, cutoff, delay) {
    renderStart = start;
    renderEnd = Math.min(cutoff, end);
    return Promise.all(
      items.slice(renderStart, renderEnd).map(
        (item) =>
          new Promise((resolve) => {
            if (item.height > 0) resolve(item.height);
            else item.resolve_render = resolve; // resolve later in onItemResized
          })
      )
    ).then(() => {
      if (!keepOnPageDuringDelay) renderStart = renderEnd;
      if (renderEnd < cutoff) {
        // init_log(`rendered items ${renderStart}-${renderEnd}`);
        if (start == 0 || Math.floor(start / 100) < Math.floor(renderEnd / 100))
          init_log(`rendered ${renderEnd}/${items.length} items (limit ${cutoff})`);
        tick().then(() => setTimeout(() => renderRange(renderEnd, renderEnd + chunk, chunk, cutoff, delay), delay));
      } else {
        init_log(`rendered ${cutoff}/${items.length} items (limit ${cutoff})`);
        rendered = true;
      }
    });
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
    if (ios) firebase().auth().signInWithRedirect(provider);
    else {
      firebase()
        .auth()
        .signInWithPopup(provider)
        .then(() => location.reload())
        .catch(console.error);
    }
  }

  function isAdmin() {
    return (
      user?.uid == "y2swh7JY2ScO5soV7mJMHVltAOX2" &&
      (location.host == "mindbox.io" || location.href.match(/user=(?:anonymous|admin)/) != null)
    );
  }

  function useAnonymousAccount() {
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

  let initialization;
  if (isClient)
    initialization = new Promise((resolve) => {
      resolve_init = resolve; // invoked from initialize()

      // set up replay log until #console is set up in onMount
      let replay_log = [];
      log_levels.forEach((verb) => {
        console["_" + verb] = console[verb];
        console[verb] = (...args) => {
          replay_log.push({ verb, args });
          return console["_" + verb](...args);
        };
      });

      console.debug(`[${window["_client_start_time"]}ms] loaded client`);

      // NOTE: We simply log the server side error as a warning. Currently only possible error is "invalid session cookie" (see session.ts), and assuming items are not returned/initialized below, firebase realtime should be able to initialize items without requiring a page reload, which is why this can be just a warning.
      if (error) console.warn(error); // log server-side error

      // pre-fetch user from localStorage instead of waiting for onAuthStateChanged
      // (seems to be much faster to render user.photoURL, but watch out for possible 403 on user.photoURL)
      if (!user && localStorage.getItem("mindpage_user")) {
        user = JSON.parse(localStorage.getItem("mindpage_user"));
        secret = localStorage.getItem("mindpage_secret"); // may be null if user was acting as anonymous
        init_log(`restored user ${user.email}`);
      } else if (window.sessionStorage.getItem("mindpage_signin_pending")) {
        init_log("resuming signin ...");
        window.sessionStorage.removeItem("mindpage_signin_pending"); // no longer considered pending
        user = secret = null;
      } else {
        useAnonymousAccount();
      }
      admin = isAdmin();
      if (admin) useAnonymousAccount(); // become anonymous for item checks below
      anonymous = user?.uid == "anonymous";
      readonly = anonymous && !admin;

      // if items were returned from server, confirm user, then initialize if valid
      if (items.length > 0) {
        if (window.sessionStorage.getItem("mindpage_signin_pending")) {
          console.warn(`ignoring ${items.length} items during signin`);
          items = [];
        } else if (user && user.uid != items[0].user) {
          // items are for wrong user, usually anonymous, due to missing/expired cookie
          // (you can test this with document.cookie='__session=;max-age=0' in console)
          // can also happen when admin is logged in but acting as anonymous
          if (items[0].user != "anonymous") console.warn(`ignoring ${items.length} items (${items[0].user})`);
          items = [];
        } else {
          // NOTE: at this point item heights (and totalItemHeight) will be zero and the loading indicator stays, but we need the items on the page to compute their heights, which will trigger updated layout through onItemResized
          initTime = Date.now(); // indicate initialization started
          initialize();
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
              init_log("signed in", user.email);
              localStorage.setItem("mindpage_user", JSON.stringify(user));
              anonymous = readonly = false; // just in case (should already be false)
              signedin = true;

              // NOTE: olcans@gmail.com signed in as "admin" will ACT as anonymous account
              //       (this is the only case where user != firebase().auth().currentUser)
              admin = isAdmin();
              if (admin) {
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
      let lastWindowHeight = 0;
      let lastFocusElem = null; // element that had focus on last recorded width/height
      function checkLayout() {
        // on android, if window height grows enough, assume keyboard is closed and blur active element
        // (otherwise e.g. tapping of tags with editor focused will scroll back up)
        if (android && outerHeight > lastWindowHeight + 200) (document.activeElement as HTMLElement).blur();

        if (Date.now() - lastScrollTime < 250) return; // avoid layout during scroll
        if (Date.now() - lastResizeTime < 250) return; // avoid layout during resizing

        const documentWidth = document.documentElement.clientWidth;
        if (
          documentWidth != lastDocumentWidth ||
          // ignore height change if active element also changed
          // (to avoid responding to temporary virtual keyboards)
          (outerHeight != lastWindowHeight && document.activeElement.isSameNode(lastFocusElem))
        ) {
          updateItemLayout();
          // resize of all elements w/ _resize attribute (and property)
          document.querySelectorAll("[_resize]").forEach((elem) => elem["_resize"]());
        }

        lastDocumentWidth = documentWidth;
        lastWindowHeight = outerHeight;
        lastFocusElem = document.activeElement;

        // update time strings every 10 seconds
        // NOTE: we do NOT update time string visibility/grouping here, and there can be differences (from layout strings) in both directions (time string hidden while distinct from previous item, or time string shown while identical to previous item) but arguably we may not want to show/hide time strings (and shift items) outside of an actual layout, and time strings should be interpreted as rough (but correct) markers along the timeline, with items grouped between them in correct order and with increments within the same order of unit (m,h,d) implied by last shown time string
        if (Date.now() - lastTimeStringUpdateTime > 10000) {
          lastTimeStringUpdateTime = Date.now();
          items.forEach((item, index) => {
            if (!item.timeString) return;
            item.timeString = itemTimeString(item.time);
          });
          items = items; // trigger svelte render
        }
      }

      document.body.addEventListener("scroll", onScroll);
      visualViewport.addEventListener("resize", onResize);

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
              snapshot.docChanges().forEach(function (change) {
                const doc = change.doc;
                // on first snapshot, if initialization has not started (initTime = 0), we simply append items into an array and then initialize; otherwise we ignore the first snapshot, which is presumably coming from a local cache so that it is cheap and worse than whatever we already got from the server
                if (firstSnapshot) {
                  if (change.type != "added") console.warn("unexpected change type: ", change.type);
                  if (initTime == 0) {
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
                    hideIndex++; // show one more item
                    onEditorChange(editorText); // integrate new item at index 0
                  } else if (change.type == "removed") {
                    // NOTE: remote remove is similar to onItemEditing (deletion case)
                    // NOTE: document may be under temporary id if it was added locally
                    let index = indexFromId.get(tempIdFromSavedId.get(doc.id) || doc.id);
                    if (index === undefined) return; // nothing to remove
                    let item = items[index];
                    itemTextChanged(index, ""); // clears label, deps, etc
                    items.splice(index, 1);
                    if (index < hideIndex) hideIndex--; // back up hide index
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
                    if (index === undefined) return; // nothing to modify
                    let item = items[index];
                    item.text = item.savedText = savedItem.text;
                    item.time = item.savedTime = savedItem.time;
                    itemTextChanged(index, item.text); // updates label, deps, etc
                    lastEditorChangeTime = 0; // disable debounce even if editor focused
                    onEditorChange(editorText); // item time/text has changed
                  }
                });
              }); // snapshot.docChanges().forEach

              // if this is first snapshot and initialization has not started (initTime = 0), start it now
              // either way set up callback to complete "synchronization" and set up welcome item if needed
              if (firstSnapshot) {
                if (!initTime) {
                  initTime = Date.now();
                  initialize();
                }
                Promise.resolve(initialization).then(() => {
                  if (!initialized) return; // initialization failed, we should be signing out ...
                  init_log(`synchronized ${items.length} items`);
                  firstSnapshot = false;

                  // if account is empty, copy the welcome item from the anonymous account, which should also trigger a request for the secret phrase in order to encrypt the new welcome item
                  if (items.length == 0) onEditorDone("/_welcome");

                  // if necessary, init secret by triggering a test encryption/decryption
                  if (!secret) {
                    const hello_item = { user: user.uid, time: Date.now(), text: "hello" };
                    encryptItem(hello_item)
                      .then(decryptItem)
                      .then((item) => {
                        if (JSON.stringify(item) != JSON.stringify(hello_item))
                          throw new Error("encryption test failed");
                      })
                      .catch(encryptionError);
                  }
                });
              }
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
        Promise.resolve(initialization).then(() => {
          let replay = true; // true until replay below
          log_levels.forEach(function (verb) {
            console[verb] = function (...args) {
              if (!replay) console["_" + verb](...args);
              if (!consolediv) {
                console["_warn"]("consolediv not ready");
                return;
              }
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
              elem.setAttribute("_level", log_levels.indexOf(verb).toString());
              consolediv.appendChild(elem);
              consoleLog.push({
                type: verb,
                stack: evalStack.slice(),
                text: text.trim(),
                time: Date.now(),
                level: log_levels.indexOf(verb),
              });
              if (consoleLog.length > consoleLogMaxSize) consoleLog = consoleLog.slice(consoleLogMaxSize / 2);

              const summarydiv = document.getElementById("console-summary");
              const summaryelem = document.createElement("span");
              summaryelem.innerText = "·";
              summaryelem.classList.add("console-" + verb);
              summarydiv.appendChild(summaryelem);

              // if console is hidden, make sure summary is visible and clickable
              if (consolediv.style.display == "none") {
                summarydiv.style.visibility = "visible";
                summarydiv.style.cursor = "pointer";
              }

              // auto-remove after 15 seconds ...
              setTimeout(() => {
                elem.remove();
                summaryelem.remove();
                if (!consolediv) return;
                if (consolediv.childNodes.length == 0) {
                  consolediv.style.display = "none";
                  summarydiv.style.visibility = "visible";
                  summarydiv.style.cursor = "auto";
                }
              }, statusLogExpiration);
            };
          });
          replay_log.forEach((entry) => console[entry.verb](...entry.args));
          replay = false;
        });

        setInterval(checkLayout, 250); // check layout every 250ms
        setInterval(checkElemCache, 1000); // check elem cache every second

        let welcome = null;
        if (readonly) {
          welcome = modal.show({
            content:
              "Welcome to MindPage! This is an **anonymous demo account**. Your edits will be discarded when you close (or reload) this page, and are _never sent or stored anywhere_.",
            // content: `Welcome ${window["_user"].name}! Your personal account requires activation. Please email support@mind.page from ${user.email} and include account identifier \`${user.uid}\` in the email.`,
            confirm: "Stay Anonymous",
            cancel: "Sign In",
            onCancel: signIn,
            background: "confirm",
          });
        }

        // evaluate _on_welcome items once initialization is done, welcome dialog is dismissed, dom is fully updated
        Promise.all([initialization, welcome])
          .then(update_dom)
          .then(() => {
            items.forEach((item) => {
              if (!item.welcome) return;
              try {
                _item(item.id).eval("_on_welcome()", { trigger: "welcome" });
              } catch (e) {} // already logged, just continue welcome eval
            });
          });

        init_log("initialized document");
      });

      init_log(`initialized client`);
    });

  let metaKey = false;
  let ctrlKey = false; // NOTE: can cause left click
  let altKey = false;
  let shiftKey = false; // NOTE: can cause unintentional text selection
  function onKeyDown(e: KeyboardEvent) {
    const key = e.code || e.key; // for android compatibility
    metaKey = e.metaKey;
    ctrlKey = e.ctrlKey;
    altKey = e.altKey;
    shiftKey = e.shiftKey;
    const modified = metaKey || ctrlKey || altKey || shiftKey;
    // console.debug(metaKey, ctrlKey, altKey, shiftKey);

    // console.debug(e, initialized, modal.isVisible());
    if (!initialized) return;
    if (modal.isVisible()) return;

    // disable arrow keys to prevent ambiguous behavior
    if (key.startsWith("Arrow")) e.preventDefault();

    // let unmodified E edit target item
    if (key == "KeyE" && !modified) {
      // edit click requires mousedown first (see onClick in Item.svelte)
      document.querySelector(".target")?.dispatchEvent(new Event("mousedown"));
      document.querySelector(".target")?.dispatchEvent(new Event("click"));
      e.preventDefault(); // avoid entering text into editor
      return;
    }
    // let unmodified R run target item
    if (key == "KeyR" && !modified) {
      document.querySelector(".target .run")?.dispatchEvent(new Event("click"));
      return;
    }
    // let unmodified T toggle logs on target item
    if (key == "KeyT" && !modified) {
      document.querySelector(".target .log-summary")?.dispatchEvent(new Event("click"));
      return;
    }
    // let unmodified J/K (or ArrowLeft/Right) select next/prev visible non-label tag in last context item
    if ((key == "KeyJ" || key == "KeyK" || key == "ArrowLeft" || key == "ArrowRight") && !modified) {
      // pick "most recently interacted context that contains selected tag"; this is usually the parent context immediately above target but does not have to be, and this approach keeps the prev/next navigation context stable while still allowing additional context to appear below/above and also allowing switching navigation context by interacting with those other context items if desired
      const lastContext = Array.from(document.querySelectorAll(".target_context"))
        .filter((e) => e.querySelector("mark.selected"))
        .sort((a, b) => item(b.getAttribute("item-id")).time - item(a.getAttribute("item-id")).time)[0];
      if (lastContext) {
        let visibleTags = Array.from(lastContext.querySelectorAll("mark:not(.hidden,.label,.deps-and-dependents *)"));
        // drop duplicates to avoid ambiguities/cycles
        visibleTags = _.uniqBy(visibleTags, (t: any) => t.title);
        let selectedIndex = visibleTags?.findIndex((e) => e.matches(".selected"));
        // if context is based on nesting (vs _context tag) and selected tag is nested under it, then we only navigate among other nested siblings, thus giving preference to nested context navigation over unstructured context navigation which can be much more confusing
        const contextLabel = (lastContext.querySelector("mark.label") as any)?.title;
        // context labels can be non-unique, so we have to use item(lastContext.getAttribute("item-id"))
        const contextBasedOnNesting = contextLabel && !item(lastContext.getAttribute("item-id")).context;
        if (
          selectedIndex >= 0 &&
          contextBasedOnNesting &&
          visibleTags[selectedIndex]["title"]?.startsWith(contextLabel + "/")
        ) {
          const selectedTag = visibleTags[selectedIndex]["title"];
          const siblings = visibleTags.filter((t) => t["title"]?.startsWith(contextLabel + "/"));
          visibleTags = siblings;
          selectedIndex = visibleTags.findIndex((e) => e.matches(".selected"));
        }
        if (selectedIndex >= 0) {
          if ((key == "KeyJ" || key == "ArrowRight") && selectedIndex < visibleTags.length - 1)
            visibleTags[selectedIndex + 1].dispatchEvent(new Event("mousedown"));
          else if ((key == "KeyK" || key == "ArrowLeft") && selectedIndex > 0)
            visibleTags[selectedIndex - 1].dispatchEvent(new Event("mousedown"));
        }
        return; // context exists, so J/K/ArrowLeft/Right assumed handled
      }
    }
    // let unmodified Enter (or ArrowDown, or ArrowRight/J if not handled above because of missing context) select first visible non-label non-secondary-selected "child" tag in target item; we avoid secondary-selected context tags since we are trying to navigate "down"
    if ((key == "Enter" || key == "ArrowDown" || key == "ArrowRight" || key == "KeyJ") && !modified) {
      // target labels are unique by definition, so no ambiguity in _item(label)
      let targetLabel = (document.querySelector(".target mark.label") as any)?.title;
      if (targetLabel) {
        // we require nested children unless target is marked _context, because otherwise going "down" into non-nested children gets confusing since the target would not appear as context
        if (item(_item(targetLabel).id).context) {
          // allow arbitrary child tag
          document
            .querySelector(".target mark:not(.hidden,.label,.secondary-selected,.deps-and-dependents *)")
            ?.dispatchEvent(new Event("mousedown"));
        } else {
          // filter to children w/ nested labels
          const childTags = Array.from(
            document.querySelectorAll(".target mark:not(.hidden,.label,.secondary-selected,.deps-and-dependents *)")
          ).filter((t) => t["title"]?.startsWith(targetLabel + "/"));
          childTags[0]?.dispatchEvent(new Event("mousedown"));
        }
      } else {
        // select first non-pinned item w/ unique label if clickable
        const id = items.find((item) => !item.pinned && item.labelUnique)?.id;
        if (id) document.querySelector(`#super-container-${id} mark.label`)?.dispatchEvent(new Event("mousedown"));
      }
      return;
    }
    // let unmodified Backspace (or ArrowUp) select label on last context item (i.e. move up to parent)
    if ((key == "Backspace" || key == "ArrowUp") && !modified) {
      // see comments above about lastContext
      const lastContext = Array.from(document.querySelectorAll(".target_context"))
        .filter((e) => e.querySelector("mark.selected"))
        .sort((a, b) => item(b.getAttribute("item-id")).time - item(a.getAttribute("item-id")).time)[0];
      if (lastContext) {
        lastContext.querySelector("mark.label")?.dispatchEvent(new Event("mousedown"));
        return;
      }
    }

    // clear non-empty editor on escape or backspace/arrowup/arrowleft/k (if not handled above)
    if (
      editorText &&
      (key == "Escape" || key == "Backspace" || key == "ArrowUp" || key == "ArrowLeft" || key == "KeyK")
    ) {
      e.preventDefault();
      // this follows onTagClick behavior
      editorText = "";
      forceNewStateOnEditorChange = true; // force new state
      finalizeStateOnEditorChange = true; // finalize state
      lastEditorChangeTime = 0; // disable debounce even if editor focused
      onEditorChange(editorText);
      return;
    }

    // resume-edit items on Shift-(save shortcut)
    if (
      (key == "KeyS" && (e.metaKey || e.ctrlKey) && e.shiftKey) ||
      (key == "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey)
    ) {
      e.preventDefault();
      resumeLastEdit();
      return;
    }

    // disable various "unfocused" item editor shortcuts, focus on editor instead
    if (focusedItem >= 0) return; // already focused on an item
    if (
      (key == "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) ||
      (key == "KeyS" && (e.metaKey || e.ctrlKey)) ||
      (key == "Slash" && (e.metaKey || e.ctrlKey)) ||
      (key == "KeyI" && e.metaKey && e.shiftKey) ||
      (key == "ArrowUp" && e.metaKey && e.altKey) ||
      (key == "ArrowDown" && e.metaKey && e.altKey) ||
      key == "Backspace" ||
      key == "Tab" ||
      key == "Escape"
    ) {
      e.preventDefault();
      textArea(-1).focus();
      document.body.scrollTo(0, 0);
      // create/run new item on create/save shortcuts
      if (
        (key == "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) ||
        (key == "KeyS" && (e.metaKey || e.ctrlKey))
      ) {
        onEditorDone(editorText, e, false, e.metaKey || e.ctrlKey /*run*/);
      }
      // create new image item on image shortcut
      if (key == "KeyI" && e.metaKey && e.shiftKey) {
        editor.insertImages(true);
      }
    }
  }
  function onKeyUp(e: KeyboardEvent) {
    metaKey = e.metaKey;
    ctrlKey = e.ctrlKey;
    altKey = e.altKey;
    shiftKey = e.shiftKey;
    // console.debug(metaKey, ctrlKey, altKey, shiftKey);
  }

  // redirect window.onerror to console.error (or alert if #console not set up yet)
  function onError(e) {
    if (!consolediv) return; // can happen during login process
    let msg = errorMessage(e);
    console.error(msg);
  }

  function onWebcamClick(e) {
    intro = !intro;
    e.stopPropagation();
    (e.target as HTMLElement).classList.toggle("intro");
  }

  // retrieve host name, in globalThis.request on server side (see server.ts)
  const hostname = typeof location == "undefined" ? globalThis.hostname : location.hostname;

  // custom directory for some static files, based on hostname
  const hostdir = ["mind.page", "mindbox.io", "olcan.com"].includes(hostname) ? hostname : "other";

  // favicon version to force updates, especially on iOS
  const favicon_version = 1;
</script>

{#if user && processed}
  <div class="items" class:multi-column={columnCount > 1} class:hide-videos={narrating}>
    {#each { length: columnCount + 1 } as _, column}
      <div class="column" class:multi-column={columnCount > 1} class:hidden={column == columnCount}>
        {#if column == 0}
          <div id="header" bind:this={headerdiv} on:click={() => textArea(-1).focus()}>
            <div id="header-container" class:focused>
              <div id="editor">
                <Editor
                  id="mindbox"
                  bind:this={editor}
                  bind:text={editorText}
                  bind:focused
                  showButtons={true}
                  cancelOnDelete={true}
                  createOnAnyModifiers={true}
                  clearOnShiftBackspace={true}
                  allowCommandCtrlBracket={true}
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
            <div id="status" class:hasDots={dotCount > 0} on:click={onStatusClick}>
              <span id="console-summary" on:click={onConsoleSummaryClick} />
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
              <div id="console" bind:this={consolediv} on:click={onConsoleClick} />
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
                        ? ""
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
                        ? ""
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
                onRun={onItemRun}
                onTouch={onItemTouch}
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
                saving={item.saving}
                running={item.running}
                admin={item.admin}
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
                missingTags={item.missingTags.join(" ")}
                matchingTerms={item.matchingTerms.join(" ")}
                matchingTermsSecondary={item.matchingTermsSecondary.join(" ")}
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
{/if}

{#if !user || !initialized || signingIn || signingOut}
  <div id="loading">
    <Circle2 size="60" unit="px" />
  </div>
{/if}

<Modal bind:this={modal} {onPastedImage} />

<svelte:window
  on:keydown={onKeyDown}
  on:keyup={onKeyUp}
  on:error={onError}
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
      /* padding-right: 11px !important; */
      /* font-family: monospace !important; */
    }
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
        console.log(`initializing webcam, config: '${localStorage.getItem("mindpage_narrating")}'; available devices:`);
        navigator.mediaDevices.enumerateDevices().then((devices) => {
          devices.forEach((device) => {
            if (device.kind == "videoinput") console.log(device.deviceId, device.label);
          });
        });
      }

      // set up video and green screen canvas
      // see https://jameshfisher.com/2020/08/10/how-to-implement-green-screen-in-webgl/
      const video = document.getElementById("webcam-video");
      const canvas = document.getElementById("webcam-canvas");
      const gl = canvas.getContext("webgl");
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, "attribute vec2 c; void main(void) { gl_Position=vec4(c, 0.0, 1.0); }");
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, document.getElementById("fragment-shader").innerText);
      gl.compileShader(fs);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.useProgram(prog);
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 1, -1, -1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const coordLoc = gl.getAttribLocation(prog, "c");
      gl.vertexAttribPointer(coordLoc, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(coordLoc);
      gl.activeTexture(gl.TEXTURE0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      const texLoc = gl.getUniformLocation(prog, "tex");
      const texWidthLoc = gl.getUniformLocation(prog, "texWidth");
      const texHeightLoc = gl.getUniformLocation(prog, "texHeight");
      const keyColorLoc = gl.getUniformLocation(prog, "keyColor");
      const similarityLoc = gl.getUniformLocation(prog, "similarity");
      const smoothnessLoc = gl.getUniformLocation(prog, "smoothness");
      const spillLoc = gl.getUniformLocation(prog, "spill");
      const toggleLoc = gl.getUniformLocation(prog, "toggle");

      // start webcam video
      navigator.mediaDevices
        .getUserMedia({
          video: _.merge(
            {
              width: 1100,
              height: 800,
              facingMode: "user",
            },
            JSON.parse(localStorage.getItem("mindpage_narrating") || "{}")
          ),
        })
        .then((stream) => {
          video.srcObject = stream;
          video.play();
          // if we can not process the video, show it directly
          if (!video.requestVideoFrameCallback) {
            video.style.visibility = "visible";
            video.style.zIndex = 1000;
            return;
          }
          function processFrame(now, metadata) {
            canvas.width = metadata.width;
            canvas.height = metadata.height;
            gl.viewport(0, 0, metadata.width, metadata.height);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
            gl.uniform1i(texLoc, 0);
            gl.uniform1f(texWidthLoc, metadata.width);
            gl.uniform1f(texHeightLoc, metadata.height);
            gl.uniform3f(keyColorLoc, 0, 1, 0);
            // see sliders at https://jameshfisher.com/2020/08/11/production-ready-green-screen-in-the-browser/
            gl.uniform1f(similarityLoc, _green_screen ? 0.49 : 0);
            gl.uniform1f(smoothnessLoc, 0.0);
            gl.uniform1f(spillLoc, 0.05);
            gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
            video.requestVideoFrameCallback(processFrame);
          }
          video.requestVideoFrameCallback(processFrame);
        })
        .catch(console.error);
    } else {
      alert("unable to access webcam");
    }
  </script>
{/if}

<svelte:head>
  <title>{hostname + (anonymous && !readonly ? "-admin" : "")}</title>
  <link rel="icon" type="image/ico" href="{hostdir}/favicon.ico?v={favicon_version}" />
  <link rel="icon" type="image/png" sizes="32x32" href="{hostdir}/favicon-32x32.png?v={favicon_version}" />
  <link rel="icon" type="image/png" sizes="16x16" href="{hostdir}/favicon-16x16.png?v={favicon_version}" />
  <!-- see https://stackoverflow.com/a/25041921 about custom apple-touch-icon location -->
  <link rel="apple-touch-icon" type="image/png" href="{hostdir}/apple-touch-icon.png?v={favicon_version}" />
  <link rel="manifest" href="/manifest.json?v={favicon_version}" />
</svelte:head>

<style>
  :global(html) {
    font-family: "Open Sans", sans-serif;
    font-weight: 400;
    /* Safari renders heavier fonts under default subpixel-antialiasing */
    -webkit-font-smoothing: antialiased;
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

  #loading {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    width: 100%;
    height: 100%;
    justify-content: center;
    align-items: center;
    /* NOTE: if you add transparency, initial zero-height layout will be visible */
    background: rgba(17, 17, 17, 0.75);
  }
  #header {
    max-width: 100%;
  }
  #header-container {
    display: flex;
    padding: 10px;
    background: #171717;
    border-radius: 0 0 5px 5px;
    border-bottom: 1px solid #222;
    /*padding-left: 2px;*/ /* matches 1px super-container padding + 1px container border */
  }
  #header-container.focused {
    background: #222; /* #222 matches #user background */
    border-bottom: 1px solid #333;
  }
  #editor {
    width: 100%;
    /* push editor down/left for more clearance for buttons and from profile picture */
    margin-top: 5px;
    margin-bottom: -5px;
    margin-left: 0px;
    margin-right: 5px;
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
    margin-left: 0;
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
    font-family: "Roboto Mono", monospace;
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
  #status {
    padding: 4px;
    height: 20px;
    text-align: center;
    font-family: "Roboto Mono", monospace;
    font-size: 12px;
    color: #999;
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
    cursor: pointer;
  }
  #status.hasDots {
    cursor: pointer;
  }
  #status .dots {
    color: #666;
  }
  #status .counts {
    font-family: sans-serif;
    font-size: 14px;
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
  #status .counts .matching,
  #status .dots .matching {
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
    /* also prevents content height going below 100%, which can trigger odd zooming/scrolling effects in iOS  */
    min-height: 100%;

    /* bottom padding for easier tapping on last item, also more stable editing/resizing of bottom items */
    padding-bottom: 50vh;
    box-sizing: border-box;
  }
  /* .items.multi-column {
    padding-bottom: 0;
  } */
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
  /* .column:last-child {
    margin-right: 0;
  } */
  /* .column:last-child {
    margin-right: 0;
  } */
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
    font-family: "Roboto Mono", monospace;
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
    #header-container {
      /*padding-left: 1px;*/ /* matches 1px container border, no super-container padding */
      padding-left: 10px; /* not best use of space, but looks good and avoids edge on curved screens */
      padding-right: 6px; /* reduced padding to save space */
    }
    #user {
      height: 55px; /* 45px = height of single-line editor (on narrow window) */
      width: 55px;
      min-width: 55px;
    }
    /* single-column layout can remove margin since there is no concern of having columns w/ same width */
    .column:not(.multi-column) {
      margin-right: 0;
    }
  }
</style>
