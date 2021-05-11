// from https://github.com/darkskyapp/string-hash/blob/master/index.js
export function hashCode(str) {
  let hash = 5381; // see https://stackoverflow.com/q/10696223
  let i = str.length;
  while (i) hash = (hash * 33) ^ str.charCodeAt(--i);
  /* JavaScript does bitwise operations (like XOR, above) on 32-bit signed
   * integers. Since we want the results to be always positive, convert the
   * signed int to an unsigned by doing an unsigned bitshift. */
  return hash >>> 0;
}

// from https://stackoverflow.com/a/2901298
export function numberWithCommas(x) {
  var parts = x.toString().split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return parts.join(".");
}

export function blockRegExp(type_regex) {
  if ("".match(type_regex)) throw new Error("invalid block type regex");
  return new RegExp("(^|\\n) *```(" + type_regex + ")\\n(?: *```|.*?\\n *```)", "gs");
}

export function extractBlock(text, type) {
  // NOTE: this logic is consistent with onInput() in Editor.svelte
  let insideBlock = false;
  let regex = RegExp("^\\s*```" + type + "(?:_hidden|_removed)?(?:\\s|$)");
  return text
    .split("\n")
    .map((line) => {
      if (!insideBlock && line.match(regex)) insideBlock = true;
      else if (insideBlock && line.match(/^\s*```/)) insideBlock = false;
      if (line.match(/^\s*```/)) return "";
      return insideBlock ? line : "";
    })
    .filter((t) => t)
    .join("\n")
    .trim();
}

export function extractImages(text) {
  return _.uniq(
    Array.from(
      text
        .replace(/(?:^|\n) *```.*?\n *```/gs, "") // remove multi-line blocks
        // NOTE: currently we miss indented blocks that start with bullets -/* (since it requires context)
        .replace(/(?:^|\n)     *[^\-\*].*(?:$|\n)/g, "") // remove 4-space indented blocks
        .replace(/(^|[^\\])`.*?`/g, "$1")
        .matchAll(/<img [^>]*?src\s*=\s*"(.*?)".*?>/gi),
      (m) => m[1]
    ).map((src) =>
      src.replace(/^https?:\/\/www\.dropbox\.com/, "https://dl.dropboxusercontent.com").replace(/\?dl=0$/, "")
    )
  );
}

import "highlight.js/styles/sunburst.css";
import hljs from "highlight.js/lib/core"; // NOTE: needs npm i @types/highlight.js -s
// custom registration function that can extend highlighting for all languages
function registerLanguage(name, func) {
  const custom_func = function (hljs) {
    let def = func(hljs);
    // interpret \\?;{___...___} as custom comment for all languages, preventing other interpretations
    // (e.g. the individual characters could be interpreted in latex)
    const comment = hljs.COMMENT(/\\?;{___/, /___}/, { className: "comment-custom", relevance: 0 });
    if (!def.contains) def.contains = [comment];
    else def.contains.unshift(comment);
    return def;
  };
  hljs.registerLanguage(name, custom_func);
}
import plaintext from "highlight.js/lib/languages/plaintext.js";
registerLanguage("plaintext", plaintext);
import javascript from "highlight.js/lib/languages/javascript.js";
registerLanguage("javascript", javascript);
import typescript from "highlight.js/lib/languages/typescript.js";
registerLanguage("typescript", typescript);
import coffeescript from "highlight.js/lib/languages/coffeescript.js";
registerLanguage("coffeescript", coffeescript);
import python from "highlight.js/lib/languages/python.js";
registerLanguage("python", python);
import css from "highlight.js/lib/languages/css.js";
registerLanguage("css", css);
import json from "highlight.js/lib/languages/json.js";
registerLanguage("json", json);
import xml from "highlight.js/lib/languages/xml.js";
registerLanguage("xml", xml); // includes html
import glsl from "highlight.js/lib/languages/glsl.js";
registerLanguage("glsl", glsl);
import latex from "highlight.js/lib/languages/latex.js";
registerLanguage("latex", latex); // includes tex
hljs.registerAliases(["js_input", "webppl_input", "webppl"], { languageName: "javascript" });
hljs.registerAliases(["math", "mathjax"], { languageName: "latex" });
hljs.configure({ tabReplace: "  " });

export function highlight(code, language) {
  // https://github.com/highlightjs/highlight.js/blob/master/SUPPORTED_LANGUAGES.md
  //if (language=="") return hljs.highlightAuto(code).value;
  language = language.replace(/(?:_removed|_hidden)$/, "");
  if (language == "_log") {
    return code
      .split("\n")
      .map((line) =>
        line
          .replace(/^(ERROR:.*)$/, '<span class="console-error">$1</span>')
          .replace(/^(WARNING:.*)$/, '<span class="console-warn">$1</span>')
          .replace(/^(INFO:.*)$/, '<span class="console-info">$1</span>')
          .replace(/^(DEBUG:.*)$/, '<span class="console-debug">$1</span>')
      )
      .join("\n");
  }
  // drop any _suffix if language does not start with _ (_lang is editor-only)
  if (!language.startsWith("_")) language = language.replace(/(^\w+?)_.+$/, "$1");
  // highlight json as javascript so e.g. quotes are not required for keys
  if (language == "json") language = "js";
  language = hljs.getLanguage(language) ? language : "plaintext";
  return hljs.highlight(language, code).value;
}

export function parseTags(text) {
  const tags = _.uniq(
    Array.from(
      text
        .replace(/(?:^|\n) *```.*?\n *```/gs, "") // remove multi-line blocks
        // NOTE: currently we miss indented blocks that start with bullets -/* (since it requires context)
        .replace(/(?:^|\n)     *[^\-\*].*(?:$|\n)/g, "") // remove 4-space indented blocks
        .replace(/(^|[^\\])`.*?`/g, "$1") // remove inline code spans
        .replace(/(^|[^\\])\$?\$`.+?`\$\$?/g, "$1") // remove math
        .replace(/(^|[^\\])<script.*?>.*?<\/script>/gs, "$1") // remove scripts (can be multi-line)
        .replace(/(^|[^\\])<style>.*?<\/style>/gs, "$1") // remove styles (can be multi-line)
        .replace(/(^|[^\\])<\/?\w.*?>/g, "$1") // remove html tags
        .replace(/(^|[^\\])<!--.*?-->/g, "$1") // remove html comment tags
        .replace(/(^|[^\\])<<.*?>>/g, "$1") // remove macros
        .replace(/(^|[^\\])@\{.*?\}@/g, "$1") // remove macros
        //.matchAll(/(?:^|[\s<>&,.;:"'`(){}\[\]])(#[^#\s<>&,.;:"'`(){}\[\]]+)/g),
        .matchAll(/(?:^|\s|\()(#[^#\s<>&,.;:!"'`(){}\[\]]+)/g),
      (m) => m[1]
    )
  );
  return {
    raw: _.uniq(tags),
    all: _.uniq(tags.map((t) => t.replace(/^#_/, "#"))),
    visible: tags.filter((t) => !t.startsWith("#_")),
    hidden: tags.filter((t) => t.startsWith("#_")).map((t) => t.replace(/^#_/, "#")),
  };
}

export function renderTag(tag) {
  return tag.replace(/^#_?\/*/, "");
}

// export function regexEscape(str) {
//   return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
// }

// NOTE: element cache invalidation should be triggered on any script/eval errors, but also whenever an item is run or <script>s executed since code dependencies can never be fully captured in cache keys (even with deephash)
export function invalidateElemCache(id) {
  if (!window["_elem_cache"][id]) return;
  // console.warn("invalidateElemCache for ", id);
  Object.values(window["_elem_cache"][id]).forEach((elem) => {
    const key = elem.getAttribute("_cache_key");
    // we allow some items to skip invalidation, e.g. to be intentionally reused across runs
    if (elem.hasAttribute("_skip_invalidation")) return;
    // console.warn("deleting from _elem_cache", key);
    delete window["_elem_cache"][id][key];
    if (elem.closest(".item")) return; // elem is live on .item
    // destroy all children and SELF w/ _destroy attribute (and property)
    elem.querySelectorAll("[_destroy]").forEach((e) => e["_destroy"]());
    if (elem._destroy) elem._destroy();
    elem.remove(); // prevents any pending chart also
  });
}

export function adoptCachedElem(elem) {
  let cachediv = document.getElementById("cache");
  if (cachediv.contains(elem)) return;
  elem["_width"] = elem.style.width;
  elem["_height"] = elem.style.height;
  elem["_position"] = elem.style.position;
  const computed = getComputedStyle(elem);
  elem.style.width = computed.width;
  elem.style.height = computed.height;
  elem.style.position = "absolute";
  elem.remove();
  cachediv.appendChild(elem);
}

export function checkElemCache() {
  if (!window["_elem_cache"]) window["_elem_cache"] = {};
  Object.keys(window["_elem_cache"]).forEach((id) => {
    Object.values(window["_elem_cache"][id]).forEach((elem) => {
      if (document.contains(elem)) return; // elem is already on the page
      const key = elem.getAttribute("_cache_key");
      // console.warn("orphaned cached element", key, "from item", window["_item"](id).name);
      // if element has zero-width, destroy it, otherwise adopt it
      if (elem.offsetWidth == 0) {
        delete window["_elem_cache"][id][key];
        // destroy all children and SELF w/ _destroy attribute (and property)
        elem.querySelectorAll("[_destroy]").forEach((e) => e["_destroy"]());
        if (elem._destroy) elem._destroy();
        elem.remove(); // prevents any pending chart also
        // console.warn("destroyed zero-width orphaned cached element", key, "from item", window["_item"](id).name);
      } else {
        adoptCachedElem(elem);
      }
    });
  });
}
