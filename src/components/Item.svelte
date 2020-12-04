<script lang="ts">
  // Markdown library requires import as ESM (ECMAScript module)
  // See https://github.com/markedjs/marked/issues/1692#issuecomment-636596320
  import marked from "marked";

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

  let renderer = new marked.Renderer();
  renderer.link = (href, title, text) => {
    return `<a target="_blank" href="${href}" onclick="event.stopPropagation()">${text}</a>`;
  };
  // marked.use({ renderer });
  marked.setOptions({
    renderer: renderer,
    highlight: function (code, language) {
      // https://github.com/highlightjs/highlight.js/blob/master/SUPPORTED_LANGUAGES.md
      //if (language=="") return hljs.highlightAuto(code).value;
      if (language == "js_input" || language == "webppl") language = "js";
      if (language == "_html") language = "html";
      language = hljs.getLanguage(language) ? language : "plaintext";
      // console.log("highlighting", validLanguage, code);
      return hljs.highlight(language, code).value;
    },
  });

  import Editor from "./Editor.svelte";
  export let editing = false;
  export let focused = false;
  export let saving = false;
  // NOTE: required props should not have default values
  export let index: number;
  export let id: string;
  export let tmpid: string; // temporary id for items created in current session
  export let page: number;
  export let itemCount: number;
  export let matchingItemCount: number;
  export let matchingTerms: any;
  export let matchingTermsSecondary: any;
  export let time: number;
  export let timeString: string;
  export let timeOutOfOrder: boolean;
  export let updateTime: number;
  export let createTime: number;

  export let text: string;
  export let height = 0;
  const placeholder = " ";
  let error = false;
  export let onEditing = (index: number, editing: boolean, backspace: boolean) => {};
  export let onFocused = (index: number, focused: boolean) => {};
  export let onResized = (itemdiv) => {};
  export let onPrev = () => {};
  export let onNext = () => {};

  let debugString;
  // NOTE: the debugString also helps get rid of the "unused property" warning
  $: debugString = `${page} ${height} ${time} ${updateTime} ${createTime} ${matchingTerms} ${matchingTermsSecondary}`;

  import { firestore } from "../../firebase.js";
  function onDone(editorText: string, e: KeyboardEvent) {
    onEditing(index, (editing = false), e.key == "Backspace");
  }
  function onClick() {
    if (window.getSelection().type == "Range") return; // ignore click if text is selected
    if (editing) return; // already editing
    onEditing(index, (editing = true), false);
  }

  export let onTagClick = (tag: string, e: MouseEvent) => {};
  window["handleTagClick"] = (tag: string, e: MouseEvent) => {
    onTagClick(tag, e);
  };

  function regexEscape(str) {
    return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
  }

  /* from https://github.com/darkskyapp/string-hash/blob/master/index.js */
  function hashCode(str): number {
    var hash = 5381,
      i = str.length;
    while (i) {
      hash = (hash * 33) ^ str.charCodeAt(--i);
    }
    /* JavaScript does bitwise operations (like XOR, above) on 32-bit signed
     * integers. Since we want the results to be always positive, convert the
     * signed int to an unsigned by doing an unsigned bitshift. */
    return hash >>> 0;
  }

  let textHash: string; // text hash computed at render time (in toHTML)
  function toHTML(text: string, matchingTerms: any, matchingTermsSecondary: any) {
    textHash = hashCode(text).toString();

    // NOTE: passing matchingTerms as an Array leads to an infinite render loop
    // console.log(matchingTerms);
    const terms = new Set<string>(matchingTerms.split(" ").filter((t) => t));
    const termsSecondary = new Set<string>(matchingTermsSecondary.split(" ").filter((t) => t));

    // parse header tags
    const headerTags = new Set(
      Array.from((text.replace(/(\s+)[^#].*/s, "$1") as any).matchAll(/(#\w+)\s+/g), (m) => m[1])
    );
    const isMenu = headerTags.has("#menu") || headerTags.has("#_menu");

    // remove hidden tags and trim
    text = text.replace(/(?:^|\s)(#_[\/\w]+)/g, "").trim();

    // replace naked URLs with markdown links (or images) named after host name
    text = text.replace(/(^|\s|>)(https?:\/\/[^\s)<]*)/g, (m, pfx, url) => {
      let sfx = "";
      if (url[url.length - 1].match(/[\.,;:]/)) {
        // move certain last characters out of the url
        sfx = url[url.length - 1] + sfx;
        url = url.substring(0, url.length - 1);
      }
      // convert dropbox urls to direct download
      url = url.replace("www.dropbox.com", "dl.dropboxusercontent.com");
      url = url.replace("?dl=0", "");
      try {
        let obj = new URL(url);
        if (url.match(/\.(jpeg|jpg|png|gif|svg)$/i)) {
          return `${pfx}<img title="${obj.host}" src="${url}">${sfx}`;
        }
        return `${pfx}[${obj.host}](${url})${sfx}`;
      } catch (_) {
        return pfx + url + sfx;
      }
    });

    let mathTermRegex = new RegExp(`\\$.*(?:${Array.from(terms).map(regexEscape).join("|")}).*\\$`, "i");

    // NOTE: modifications should only happen outside of code blocks
    let insideBlock = false;
    let lastLine = "";
    text = text
      .split("\n")
      .map((line) => {
        let str = line;
        if (!insideBlock && str.match(/^\s*```/s))
          // allow extra chars (consistent w/ marked)
          insideBlock = true;
        else if (insideBlock && str.match(/^\s*```\s*$/s))
          // do not allow extra chars (consistent w/ marked)
          insideBlock = false;

        // preserve inline whitespace and line breaks by inserting &nbsp; and <br> outside of code blocks
        // (we exclude |^> to break inside blockquotes for now)
        if (!insideBlock && !str.match(/^\s*```|^    \s*[^\-\*]|^\s*<|^\s*>/)) {
          str = str.replace(/(\S)(\s\s+)/g, (m, pfx, space) => {
            return pfx + space.replace(/  /g, " &nbsp;");
          });
          str = str + "<br>\n";
        }
        // NOTE: sometimes we don't want <br> but we still need an extra \n for markdown parser
        if (!insideBlock && str.match(/^\s*```|^\s*</)) str += "\n";
        // NOTE: for blockquotes (>...) we need to break lines using double-space
        if (!insideBlock && str.match(/^\s*>/)) str += "  ";
        if (!insideBlock && !str.match(/^\s*```|^    \s*[^\-\*]|^\s*</)) {
          // wrap math inside span.math (unless text matches search terms)
          if (terms.size == 0 || (!str.match(mathTermRegex) && !terms.has("$")))
            str = str.replace(/(\$\$?.+?\$\$?)/g, '<span class="math">$1</span>');
          // style vertical separator bar │
          str = str.replace(/│/g, '<span class="vertical-bar">│</span>');
          // wrap #tags inside clickable <mark></mark>
          str = str.replace(
            /(^|\s)(#[\/\w]+)/g,
            (match, pfx, tag) =>
              `${pfx}<mark ${
                terms.has(tag) ? 'class="selected"' : termsSecondary.has(tag) ? 'class="secondary-selected"' : ""
              } onclick="handleTagClick('${tag}',event);event.stopPropagation()">${tag}</mark>`
          );
        }
        // close blockquotes with an extra \n before next line
        // NOTE: this does not work for nested blockquotes (e.g. going from  >> to >), which requires counting >s
        if (!insideBlock && lastLine.match(/^\s*>/) && !line.match(/^\s*>/)) str = "\n" + str;
        lastLine = line;
        return str;
      })
      .join("\n")
      .replace(/\\<br>\n\n/g, "")
      .replace(/<hr(.*?)>\s*<br>/g, "<hr$1>")
      .replace(
        /(?:^|\n)```_html\w*?\n\s*(.*?)\s*\n```/gs,
        (m, _html) =>
          _html
            .replace(/\$id/g, tmpid ? tmpid : id)
            .replace(/\$hash/g, textHash)
            .replace(/\n+/g, "\n") // prevents insertion of <br> by marked(text) below
      ) /*unwrap _html_ blocks*/;

    if (isMenu) {
      // parse icon replacement urls
      let replacements = (text as any).matchAll(/<!-- (\w+?) (.+?) -->/g);
      for (let pair of replacements) {
        text = text.replace(pair[1], pair[2]);
      }
    }

    // apply hidden divs
    text = text.replace(/<!--\s*hidden\s*-->(.*?)<!--\s*\/hidden\s*-->/gs, '<div style="display:none">$1</div>');

    text = marked(text);
    if (isMenu) text = '<div class="menu">' + text + "</div>";

    // process images to transform src and add _cache_key attribute
    text = text.replace(/<img .*?src="(.+?)".*?>/gi, function (m, src) {
      if (m.match(/_cache_key/i)) {
        console.warn("img with self-assigned _cache_key");
        return m;
      }
      // convert dropbox image src urls to direct download
      src = src.replace("www.dropbox.com", "dl.dropboxusercontent.com").replace("?dl=0", "");
      m = m.replace(/ src=[^> ]*/, "");
      m = m.replace(/ _cache_key=[^> ]*/, "");
      // console.log("img src", src, m);
      return m.substring(0, m.length - 1) + ` src="${src}" _cache_key="${src}">`;
    });

    return text;
  }

  // we use afterUpdate hook to make changes to the DOM after rendering/updates
  let itemdiv: HTMLDivElement;
  import { afterUpdate } from "svelte";

  function cacheElems() {
    // cache (restore) elements with attribute _cache_key to (from) window[_cache][_cache_key]
    if (window["_cache"] == undefined) window["_cache"] = {};
    Array.from(itemdiv.querySelectorAll("[_cache_key]")).forEach((elem) => {
      if (elem.hasAttribute("_cached")) return; // already cached/restored
      const key = elem.getAttribute("_cache_key");
      if (window["_cache"].hasOwnProperty(key)) {
        // console.log("reusing cached element", key, elem.tagName);
        elem.replaceWith(window["_cache"][key]);
      } else {
        if (elem.querySelector("script")) return; // contains script; must be cached after script is executed
        elem.setAttribute("_cached", Date.now().toString());
        elem.setAttribute("_item", id); // for invalidating cached elems on errors
        // console.log("caching element", key, elem.tagName);
        window["_cache"][key] = elem; //.cloneNode(true);
      }
    });
  }

  function renderMath(elems, done = null) {
    if (elems.length == 0) return;
    window["MathJax"]
      .typesetPromise(elems)
      .then(() => {
        const itemdiv = elems[0].closest(".item");
        // NOTE: inTabOrder: false option updates context menu but fails to set tabindex to -1 so we do it here
        itemdiv.querySelectorAll(".MathJax").forEach((elem) => elem.setAttribute("tabindex", "-1"));
        if (done) done();
        onResized(itemdiv);
      })
      .catch(console.error);
  }

  afterUpdate(() => {
    if (!itemdiv) return; // itemdiv is null if editing
    // NOTE: this function must be fast and idempotent, as it can be called multiple times on the same item
    // NOTE: additional invocations can be on an existing DOM element, e.g. one with MathJax typesetting in it
    // NOTE: always invoked twice for new items due to id change after first save
    // NOTE: invoked on every sort, e.g. during search-as-you-type
    // NOTE: empirically, svelte replaces _children_ of itemdiv, so any attributes must be stored on children
    //       (otherwise changes to children, e.g. rendered math, can disappear and not get replaced)
    if (!itemdiv.firstElementChild) itemdiv.appendChild(document.createElement("span"));
    if (
      textHash == itemdiv.firstElementChild.getAttribute("_textHash") &&
      matchingTerms == itemdiv.firstElementChild.getAttribute("_highlightTerms")
    ) {
      return;
    }
    itemdiv.firstElementChild.setAttribute("_textHash", textHash);
    itemdiv.firstElementChild.setAttribute("_highlightTerms", matchingTerms);

    // cache any elements with _cache_key (invoked again later for elements with scripts)
    cacheElems();

    // highlight matching terms in item text
    // NOTE: this can be slow so we do it async
    const matchingTermsAtDispatch = matchingTerms;
    setTimeout(() => {
      if (!itemdiv) return;
      if (matchingTerms != matchingTermsAtDispatch) return;
      Array.from(itemdiv.querySelectorAll("span.highlight")).forEach((span) => {
        span.outerHTML = span.innerHTML;
      });
      const terms = matchingTerms.split(" ").filter((t) => t);
      if (terms.length == 0) return;
      let treeWalker = document.createTreeWalker(itemdiv, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: function (node) {
          switch (node.nodeName.toLowerCase()) {
            case "mark":
              return (node as HTMLElement).className == "selected"
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT;
            case "svg":
            case "math":
            case "script":
              return NodeFilter.FILTER_REJECT;
            default:
              return NodeFilter.FILTER_ACCEPT;
          }
        },
      });
      while (treeWalker.nextNode()) {
        let node = treeWalker.currentNode;
        if (node.nodeType != Node.TEXT_NODE) continue;
        let parent = node.parentNode;
        let text = node.nodeValue;
        let m;
        let regex = new RegExp(`^(.*?)(${terms.map(regexEscape).join("|")})`, "si");
        while ((m = text.match(regex))) {
          text = text.slice(m[0].length);
          parent.insertBefore(document.createTextNode(m[1]), node);
          var word = parent.insertBefore(document.createElement("span"), node);
          word.appendChild(document.createTextNode(m[2]));
          word.className = "highlight";
          if (node.parentElement.tagName == "MARK") {
            // NOTE: this becomes stale when the match goes away
            // node.parentElement.style.background = "white";
            // adjust margin/padding and border radius for in-tag (in-mark) matches
            const tagStyle = window.getComputedStyle(node.parentElement);
            word.style.borderRadius = "0";
            // NOTE: marks (i.e. tags) can have more vertical padding (e.g. under .menu class)
            // word.style.paddingTop = tagStyle.paddingTop;
            // word.style.paddingBottom = tagStyle.paddingBottom;
            if (m[2][0] == "#") {
              // prefix match (rounded on left)
              word.style.paddingLeft = tagStyle.paddingLeft;
              word.style.marginLeft = "-" + tagStyle.paddingLeft;
              word.style.borderTopLeftRadius;
              word.style.borderTopLeftRadius = tagStyle.borderTopLeftRadius;
              word.style.borderBottomLeftRadius = tagStyle.borderBottomLeftRadius;
            }
            if (text.length == 0) {
              // suffix match (rounded on right)
              word.style.paddingRight = tagStyle.paddingRight;
              word.style.marginRight = "-" + tagStyle.paddingRight;
              word.style.borderTopRightRadius = tagStyle.borderTopLeftRadius;
              word.style.borderBottomRightRadius = tagStyle.borderBottomLeftRadius;
            }
          }
        }
        node.nodeValue = text;
      }
    });

    // remove <code></code> wrapper block
    Array.from(itemdiv.getElementsByTagName("code")).forEach((code) => {
      if (code.textContent.startsWith("$") && code.textContent.endsWith("$")) code.outerHTML = code.innerHTML;
    });

    // replace <pre></pre> wrapper with <blockquote></blockquote>
    Array.from(itemdiv.getElementsByTagName("pre")).forEach((pre) => {
      if (pre.textContent.startsWith("$") && pre.textContent.endsWith("$"))
        pre.outerHTML = "<blockquote>" + pre.innerHTML + "</blockquote>";
    });

    // NOTE: we only report inner item height, NOT the time string height, since otherwise item heights would appear to change frequently based on ordering of items. Instead time string height must be added separately.
    setTimeout(() => {
      if (itemdiv) onResized(itemdiv);
    }, 0);

    // trigger typesetting of any math elements
    let math = [];
    Array.from(itemdiv.getElementsByClassName("math")).forEach((elem) => {
      if (elem.hasAttribute("_rendered")) return;
      // console.log("rendering math", math.innerHTML);
      elem.setAttribute("_rendered", Date.now().toString());
      math.push(elem);
    });
    renderMath(math);

    // set up img tags to enable caching and invoke onResized onload
    Array.from(itemdiv.querySelectorAll("img")).forEach((img) => {
      if (img.hasAttribute("_loaded")) return; // already loaded (and presumably restored from cache)
      if (!img.hasAttribute("src")) {
        console.warn("img missing src");
        return;
      }
      if (!img.hasAttribute("_cache_key")) {
        console.warn("img missing _cache_key (should be automatically added)");
        return;
      }
      if (img.getAttribute("_cache_key") != img.src) {
        console.warn("img _cache_key does not match src");
        return;
      }
      img.onload = () => {
        if (itemdiv) onResized(itemdiv);
        img.setAttribute("_loaded", Date.now().toString());
      };
    });

    // trigger execution of script tags by adding/removing them to <head>
    // NOTE: this is slow, so we do it asyc, and we warn if the parent element is not cached
    setTimeout(() => {
      if (!itemdiv) return;
      const scripts = itemdiv.getElementsByTagName("script");
      // wait for all scripts to be done, then update height in case it changes
      let pendingScripts = scripts.length;
      let scriptErrors = [];
      if (pendingScripts > 0) {
        // console.log(`executing ${pendingScripts} scripts in item ${index + 1} ...`);
        Array.from(scripts).forEach((script) => {
          if (!script.hasAttribute("_uncached")) {
            if (!script.parentElement.hasAttribute("_cache_key")) {
              // auto-cache non-item parent with item-unique id (that contains $id) with _cache_key="<id>-$hash"
              if (script.parentElement.id.indexOf(id) >= 0 && !script.parentElement.classList.contains("item")) {
                script.parentElement.setAttribute("_cache_key", script.parentElement.id + "-" + textHash);
              } else {
                console.warn("script will execute at every render due to uncached parent (missing _cache_key)");
              }
            }
          }
          script.remove(); // remove script to indicate execution
          let clone = document.createElement("script");
          clone.type = script.type || "text/javascript";
          // NOTE: we only support sync embedded scripts for now for simplicity in error handling; if async scripts are needed again in the future, then we need to see if element.onerror works; if so, then we just need to have onload and onerror to invoke the completion logic below (_script_item_id and _errors can be skipped)
          // if (script.hasAttribute("src")) clone.src = script.src;
          // console.log(script.innerHTML);
          clone.innerHTML = `(function(){ ${script.innerHTML} })()`;
          window["_script_item_id"] = id;
          window["_errors"] = [];
          document.head.appendChild(clone);
          document.head.removeChild(clone);
          window["_script_item_id"] = "";
          scriptErrors = scriptErrors.concat(window["_errors"]);

          pendingScripts--;
          if (pendingScripts == 0) {
            // console.log(`all scripts done in item ${index + 1}`);
            if (itemdiv) {
              onResized(itemdiv);
              // if no errors, cache elems with _cache_key that had scripts in them
              // if error occurred, remove any cached elements for item to force restore/rerun scripts
              if (scriptErrors.length == 0) {
                cacheElems();
                // render new math inside dot graph nodes that may have been rendered by the script
                Array.from(itemdiv.querySelectorAll(".dot")).forEach((dot) => {
                  dot["_dotrendered"] = function () {
                    // render "stack" clusters (subgraphs)
                    Array.from(dot.querySelectorAll(".cluster.stack")).forEach((cluster) => {
                      let path = cluster.children[1]; // first child is title
                      (path as HTMLElement).setAttribute("fill", "#111");
                      let path2 = path.cloneNode();
                      (path2 as HTMLElement).setAttribute("transform", "translate(-3,3)");
                      (path2 as HTMLElement).setAttribute("opacity", "0.75");
                      cluster.insertBefore(path2, path);
                      let path3 = path.cloneNode();
                      (path3 as HTMLElement).setAttribute("transform", "translate(-6,6)");
                      (path3 as HTMLElement).setAttribute("opacity", "0.5");
                      cluster.insertBefore(path3, path2);
                    });

                    // render math in text nodes
                    let math = [];
                    Array.from(dot.querySelectorAll("text")).forEach((text) => {
                      if (text.textContent.match(/^\$.+\$$/)) {
                        text["_bbox"] = (text as SVGGraphicsElement).getBBox(); // needed below
                        math.push(text);
                      }
                    });
                    renderMath(math, function () {
                      dot.querySelectorAll(".node > text > .MathJax > svg > *").forEach((elem) => {
                        let math = elem as SVGGraphicsElement;
                        let dot = elem.parentNode.parentNode.parentNode.parentNode;
                        // NOTE: node can have multiple shapes as children, e.g. doublecircle nodes have two
                        let shape = dot.children[1] as SVGGraphicsElement; // shape (e.g. ellipse) is second child
                        let text = dot.children[dot.children.length - 1]; // text is last child
                        let shaperect = shape.getBBox();
                        let textrect = text["_bbox"]; // recover text bbox pre-mathjax
                        let textscale = textrect.height / shaperect.height; // fontsize-based scaling factor
                        elem.parentElement.parentElement.parentElement.remove(); // remove text node
                        dot.appendChild(elem);
                        let mathrect = math.getBBox();
                        let scale = (0.6 * textscale * shaperect.height) / mathrect.height;
                        let xt0 = -mathrect.x;
                        let yt0 = -mathrect.y;
                        let xt = shaperect.x + shaperect.width / 2 - (mathrect.width * scale) / 2;
                        let yt = shaperect.y + shaperect.height / 2 + (mathrect.height * scale) / 2;
                        elem.setAttribute(
                          "transform",
                          `translate(${xt},${yt}) scale(${scale},-${scale}) translate(${xt0},${yt0})`
                        );
                      });
                    });
                  };
                });
              } else {
                Object.values(window["_cache"]).filter((elem: HTMLElement) => {
                  if (elem.getAttribute("_item") == id) {
                    console.log(`removing cached element for item ${index + 1}`);
                    delete window["_cache"][elem.getAttribute("_cache_key")];
                    // destroy any c3 charts inside element
                    Array.from(elem.querySelectorAll(".c3")).map((div) => {
                      if (div["_chart"]) {
                        div["_chart"].destroy();
                        delete div["_chart"];
                      }
                    });
                  }
                });
              }
            }
          }
        });
      }
    }, 0);
  });
</script>

<style>
  .super-container {
    break-inside: avoid;
    padding: 4px 0;
    padding-right: 8px;
    /* max-width: 750px; */
  }
  .container {
    position: relative;
    /* border: 1px solid transparent; */
    border-left: 2px solid #444;
    /* overflow: hidden; */
  }
  .container.focused {
    /* border: 1px solid #666; */
    border-left: 2px solid #aaa;
  }
  .index {
    position: absolute;
    top: 0;
    right: 0;
    z-index: 1;
    color: #666;
    /* padding-right: 4px; */
    font-family: Avenir Next, Helvetica;
    text-align: right;
    opacity: 0.5;
  }
  .index.matching {
    color: lightgreen;
  }
  .index .itemCount {
    color: #ddd;
  }
  .index .matchingItemCount {
    color: lightgreen;
  }

  .time {
    color: #444;
    display: inline-block;
    padding-left: 5px;
    padding-right: 5px;
    margin-bottom: 4px;
    font-family: Avenir Next, Helvetica;
    font-size: 15px;
  }
  .time.timeOutOfOrder {
    background: #666;
    padding-left: 15px;
    padding-bottom: 1px;
    color: black;
    border-radius: 0 4px 4px 0;
    /* display: block; */
  }
  .debug {
    /* display: inline-block; */
    display: none;
    color: #444;
    font-family: Avenir Next, Helvetica;
  }
  .item {
    color: #ddd;
    width: 100%;
    /* min-height: 42px; */
    background: transparent;
    padding: 10px;
    box-sizing: border-box;
    /* white-space: pre-wrap; */
    word-wrap: break-word;
    font-family: Avenir Next, Helvetica;
    font-size: 18px;
    line-height: 28px;
    /* cursor: pointer; */
  }
  .saving {
    opacity: 0.5;
  }
  .error {
    color: red;
  }

  /* :global prevents unused css errors and allows matches to elements from other components (see https://svelte.dev/docs#style) */
  :global(h1, h2, h3, h4, h5, h6, p, ul, blockquote, pre) {
    margin: 0;
  }
  /* :global(h1, h2, h3, h4, h5, h6) {
    clear: both;
  } */
  :global(.item li) {
    text-indent: -3px;
  }
  :global(.item ul) {
    padding-left: 20px;
    /* border-left: 1px solid #333; */
  }
  /* NOTE: blockquotes (>...) are not monospaced and can keep .item font*/
  :global(.item blockquote) {
    padding-left: 5px;
    margin-bottom: 10px;
    border-left: 1px solid #333;
  }
  /* NOTE: these font sizes should match those in Editor */
  :global(.item pre) {
    padding-left: 5px;
    margin-bottom: 10px;
    border-left: 1px solid #333;
    font-size: 15px;
    line-height: 25px;
  }
  :global(.item code) {
    font-size: 15px;
    line-height: 25px;
    white-space: pre; /* preserve whitespace, break on \n only */
    background: #222;
    padding: 2px 4px;
    border-radius: 4px;
  }
  :global(.item pre code) {
    background: none;
    padding: 0;
    border-radius: 0;
  }
  :global(.item br:last-child) {
    display: none;
  }
  :global(.item a) {
    color: #79e;
    background: #222;
    padding: 1px 4px;
    border-radius: 4px;
    text-decoration: none;
  }
  :global(.item mark) {
    color: black;
    background: #999;
    /* remove negative margins used to align with textarea text */
    padding: 1px 4px;
    margin: 0;
  }
  /* .menu styling: paragraphs become flex boxes */
  :global(.item .menu p) {
    display: flex;
    width: 95%; /* leave some extra space for editing and item count/index indicators */
  }
  :global(.item .menu a, .item .menu mark) {
    padding: 8px;
  }
  :global(.item .menu p a, .item .menu p mark) {
    flex: 1 1 auto;
    text-align: center;
    margin: 2px;
  }
  :global(.item .menu img) {
    width: 24px;
    height: 24px;
    min-width: 24px; /* necessary on smaller device */
    vertical-align: middle;
  }

  :global(.item mark.selected) {
    background: lightgreen;
  }
  :global(.item mark.secondary-selected) {
    background: white;
  }
  :global(.item span.highlight) {
    color: black;
    background: lightgreen;
    border-radius: 4px;
  }
  :global(.item mark span.highlight) {
    color: black;
    background: lightgreen;
    padding: 1px 0;
  }
  :global(.item .vertical-bar) {
    color: #444;
  }
  :global(.item .math) {
    display: inline-block;
    /* background: #222; */
    /* padding: 2px 4px; */
    border-radius: 4px;
  }
  :global(.item hr) {
    background: transparent;
    border: 0;
    border-top: 1px dashed #222;
    height: 1px; /* disappears if both height and border are 0 */
    margin: 10px 0;
    clear: both; /* clear floats on both sides by default */
  }
  :global(.item img) {
    max-width: 100%;
  }
  /* NOTE: this caused first <mark> under .menu > p to lose its upper margin and lose alignment */
  /* :global(.item :first-child) {
    margin-top: 0;
  } */
  :global(.item :last-child) {
    margin-bottom: 0;
  }
  :global(.item .MathJax) {
    margin-bottom: 0;
  }
  :global(.item blockquote .MathJax) {
    display: block;
  }
  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    :global(.item .menu a, .item .menu mark) {
      padding: 8px 4px;
    }
    .item {
      font-size: 16px;
      line-height: 25px;
    }
    .time {
      font-size: 14px;
    }
    /* NOTE: these font sizes should match those in Editor */
    :global(.item pre, .item code) {
      font-size: 13px;
      line-height: 22px;
    }
  }
</style>

<div class="super-container" on:click={onClick}>
  {#if timeString}
    <div class="time" class:timeOutOfOrder>{timeString}</div>
  {/if}
  <div class="debug">{debugString}</div>
  <div class="container" class:editing class:focused class:timeOutOfOrder>
    <div class="index" class:matching={matchingTerms.length > 0}>
      {#if index == 0}
        <span class="itemCount">{itemCount}</span><br />
        {#if matchingItemCount > 0}<span class="matchingItemCount">{matchingItemCount}</span><br />{/if}
      {/if}
      {index + 1}
      <!-- <br /> {height} -->
    </div>
    {#if editing}
      <Editor
        {id}
        bind:text
        bind:focused
        {onPrev}
        {onNext}
        onFocused={(focused) => onFocused(index, focused)}
        {onDone} />
    {:else}
      <div class="item" {id} bind:this={itemdiv} class:saving class:error>
        {@html toHTML(text || placeholder, matchingTerms, matchingTermsSecondary)}
      </div>
    {/if}
  </div>
</div>
