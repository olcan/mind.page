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
  let regex = RegExp("^\\s*```" + type + "(\\s|$)");
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
import plaintext from "highlight.js/lib/languages/plaintext.js";
hljs.registerLanguage("plaintext", plaintext);
import javascript from "highlight.js/lib/languages/javascript.js";
hljs.registerLanguage("javascript", javascript);
import typescript from "highlight.js/lib/languages/typescript.js";
hljs.registerLanguage("typescript", typescript);
import css from "highlight.js/lib/languages/css.js";
hljs.registerLanguage("css", css);
import json from "highlight.js/lib/languages/json.js";
hljs.registerLanguage("json", json);
import xml from "highlight.js/lib/languages/xml.js";
hljs.registerLanguage("xml", xml); // including html
hljs.configure({
  tabReplace: "  ",
});
export function highlight(code, language) {
  // https://github.com/highlightjs/highlight.js/blob/master/SUPPORTED_LANGUAGES.md
  //if (language=="") return hljs.highlightAuto(code).value;
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
  if (language == "js_input" || language == "webppl" || language == "webppl_input") language = "js";
  if (language.startsWith("_html")) language = "html";
  language = hljs.getLanguage(language) ? language : "plaintext";
  return hljs.highlight(language, code).value;
}
