// from https://github.com/darkskyapp/string-hash/blob/master/index.js
export function hashCode(str) {
  let hash = 5381;
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

// Promise.delay from https://stackoverflow.com/a/39538518
export function delay(t, v) {
  return new Promise((resolve) => setTimeout(resolve.bind(null, v), t));
}
if (typeof window != "undefined") window.delay = delay;
Promise.prototype.delay = function (t) {
  return this.then((v) => delay(t, v));
};

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

import "highlight.js/styles/sunburst.css";
import hljs from "highlight.js/lib/core"; // NOTE: needs npm i @types/highlight.js -s
// custom registration function that can extend highlighting for all languages
function registerLanguage(name, func) {
  const custom_func = function (hljs) {
    let def = func(hljs);
    // interpret %%__%% for all languages (turns out to be critical for css)
    let comment = hljs.COMMENT("%%_", "_%%", { className: "comment-custom", relevance: 0 });
    if (!def.contains) def.contains = [];
    def.contains.push(hljs.COMMENT("%%_", "_%%", { className: "comment-custom", relevance: 0 }));
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
import css from "highlight.js/lib/languages/css.js";
registerLanguage("css", css);
import json from "highlight.js/lib/languages/json.js";
registerLanguage("json", json);
import xml from "highlight.js/lib/languages/xml.js";
registerLanguage("xml", xml); // includes html
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
  if (language.match(/^_?html(_|$)/)) language = "html";
  if (language.match(/^_?js(_|$)/)) language = "js";
  // if (language.startsWith("_math")) language = "math"; // editor-only
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
        .replace(/(^|[^\\])<<.*?>>/g, "$1") // remove macros
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

export function regexEscape(str) {
  return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
}
