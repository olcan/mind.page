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
    return `<a target="_blank" href="${href}" title="${
      title || text
    }" onclick="event.stopPropagation()">${text}</a>`;
  };
  // marked.use({ renderer });
  marked.setOptions({
    renderer: renderer,
    highlight: function (code, language) {
      // https://github.com/highlightjs/highlight.js/blob/master/SUPPORTED_LANGUAGES.md
      //if (language=="") return hljs.highlightAuto(code).value;
      if (language == "js_input") language = "js";
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
  export let itemCount: number;
  export let matchingItemCount: number;
  export let matchingTerms: any;
  export let matchingTermsSecondary: any;
  export let time: number;
  export let timeString: string;
  export let timeOutOfOrder: boolean;
  export let updateTime: number;
  export let createTime: number;
  let debugString;
  $: debugString = `${time} ${updateTime} ${createTime} ${matchingTerms} ${matchingTermsSecondary}`;

  export let text: string;
  export let height = 0;
  const placeholder = " ";
  let error = false;
  export let onEditing = (index: number, editing: boolean) => {};
  export let onFocused = (index: number, focused: boolean) => {};
  export let onHeightAsync = (
    id: string,
    height: number,
    prevheight: number
  ) => {};
  export let onPrev = () => {};
  export let onNext = () => {};

  import { firestore } from "../../firebase.js";
  function onDone() {
    onEditing(index, (editing = false));
  }
  function onClick() {
    if (window.getSelection().type == "Range") return; // ignore click if text is selected
    onEditing(index, (editing = true));
  }

  export let onTagClick = (tag: string) => {};
  window["handleTagClick"] = (tag: string) => {
    onTagClick(tag);
  };

  function regexEscape(str) {
    return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
  }

  function toHTML(
    text: string,
    matchingTerms: any,
    matchingTermsSecondary: any
  ) {
    // NOTE: passing matchingTerms as an Array leads to an infinite render loop
    // console.log(matchingTerms);
    const terms = new Set<string>(matchingTerms.split(",").filter((t) => t));
    const termsSecondary = new Set<string>(
      matchingTermsSecondary.split(",").filter((t) => t)
    );

    // hide starting #pin and #pin/* (not useful visually or for clicking)
    text = text.replace(/^#pin(?:\s|$)/, "");
    text = text.replace(/^#pin\/[\/\w]*(?:\s|$)/, "");

    // replace naked URLs with markdown links named after host name
    text = text.replace(/(^|\s)(https?:\/\/[^\s)]*)/g, (m, pfx, url) => {
      let sfx = "";
      if (url[url.length - 1] == ".") {
        // move ending period to the suffix
        url = url.substring(0, url.length - 1);
        sfx = "." + sfx;
      }
      try {
        let obj = new URL(url);
        return `${pfx}[${obj.host}](${url})${sfx}`;
      } catch (_) {
        return pfx + url + sfx;
      }
    });

    // NOTE: modifications should only happen outside of code blocks
    let insideMultilineBlock = false;
    text = text
      .split("\n")
      .map((line) => {
        let str = line;
        // disable MathJax syntax that contains matching terms
        terms.forEach((term: string) => {
          const regex = RegExp(`\\$(.*)${regexEscape(term)}(.*)\\$`, "si");
          str = str.replace(regex, "&#36;$1" + term + "$2&#36;");
        });
        if (!insideMultilineBlock && str.match(/^```/s))
          // allow extra chars (consistent w/ marked)
          insideMultilineBlock = true;
        else if (insideMultilineBlock && str.match(/^```\s*$/s))
          // do not allow extra chars (consistent w/ marked)
          insideMultilineBlock = false;

        // preserve line breaks by inserting <br> outside of code blocks
        if (!insideMultilineBlock && !str.match(/^```/)) str += "<br>\n";
        if (!insideMultilineBlock && !str.match(/^```/) && !str.match(/^</)) {
          // style vertical separator bar │
          str = str.replace(/│/g, '<span class="vertical-bar">│</span>');
          // wrap #tags inside clickable <mark></mark>
          str = str.replace(
            /(^|\s)(#[\/\w]+)/g,
            (match, pfx, tag) =>
              `${pfx}<mark ${
                terms.has(tag)
                  ? 'class="selected"'
                  : termsSecondary.has(tag)
                  ? 'class="secondary-selected"'
                  : ""
              } onclick="handleTagClick('${tag}');event.stopPropagation()">${tag}</mark>`
          );
        }
        return str;
      })
      .join("\n")
      .replace(/\\<br>\n\n/g, "")
      .replace(/<hr(.*?)>\s*<br>/g, "<hr$1>")
      .replace(
        /\n```_html\w*?\n\s*(<.*?>)\s*\n```/gs,
        "$1<br>"
      ) /*unwrap _html_ blocks*/;
    return marked(text);
  }

  // we use afterUpdate hook to make changes to the DOM after rendering
  let containerdiv: HTMLDivElement;
  let itemdiv: HTMLDivElement;
  import { afterUpdate } from "svelte";
  afterUpdate(() => {
    if (!itemdiv) return; // itemdiv is null if editing
    // NOTE: this function must be fast and idempotent, as it can be called multiple times on the same item
    // NOTE: additional invocations can be on an existing DOM element, e.g. one with MathJax typesetting in it
    // NOTE: always invoked twice for new items due to id change after first save
    // NOTE: invoked on every sort, e.g. during search-as-you-type
    //       (following logic prevents this, proving divs are reused)
    if (itemdiv.hasAttribute("_updated")) return;
    itemdiv.setAttribute("_updated", Date.now().toString());

    // cache cacheable divs under window[_cached_divs][_cache_key]
    if (window["_cached_divs"] == undefined) window["_cached_divs"] = {};
    Array.from(itemdiv.querySelectorAll(".cacheable")).forEach((div) => {
      if (div.hasAttribute("_cached")) return;
      const key = div.getAttribute("_cache_key");
      div.setAttribute("_cached", Date.now().toString());
      console.log("caching div", key);
      window["_cached_divs"][key] = div; //.cloneNode(true);
    });

    // restore any cached divs
    Array.from(itemdiv.querySelectorAll(".cacheable")).forEach((div) => {
      if (div.hasAttribute("_cached")) return;
      const key = div.getAttribute("_cache_key");
      if (window["_cached_divs"].hasOwnProperty(key)) {
        console.log("reusing cached div", key);
        div.replaceWith(window["_cached_divs"][key]);
      }
    });

    // highlight search terms that matched in item text
    if (matchingTerms != itemdiv.getAttribute("_highlightTerms")) {
      itemdiv.setAttribute("_highlightTerms", matchingTerms);
      // if (!itemdiv.getAttribute("_origHTML"))
      //   itemdiv.setAttribute("_origHTML", itemdiv.innerHTML);
      // itemdiv.innerHTML = itemdiv.getAttribute("_origHTML");
      Array.from(itemdiv.querySelectorAll("span.highlight")).forEach((span) => {
        span.outerHTML = span.innerHTML;
      });
      const terms = matchingTerms.split(",").filter((t) => t);
      let treeWalker = document.createTreeWalker(
        itemdiv,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: function (node) {
            switch (node.nodeName.toLowerCase()) {
              case "mark":
                return (node as HTMLElement).className == "selected"
                  ? NodeFilter.FILTER_REJECT
                  : NodeFilter.FILTER_ACCEPT;
              case "svg":
              case "math":
                return NodeFilter.FILTER_REJECT;
              default:
                return NodeFilter.FILTER_ACCEPT;
            }
          },
        }
      );
      while (treeWalker.nextNode()) {
        let node = treeWalker.currentNode;
        if (node.nodeType != Node.TEXT_NODE) continue;
        let parent = node.parentNode;
        let text = node.nodeValue;
        let m;
        terms.forEach((term) => {
          let regex = new RegExp(`^(.*?)(${regexEscape(term)})`, "si");
          while ((m = text.match(regex))) {
            text = text.slice(m[0].length);
            parent.insertBefore(document.createTextNode(m[1]), node);
            var word = parent.insertBefore(
              document.createElement("span"),
              node
            );
            word.appendChild(document.createTextNode(m[2]));
            word.className = "highlight";
            if (node.parentElement.tagName == "MARK") {
              // NOTE: this becomes stale when the match goes away
              // node.parentElement.style.background = "white";
              // adjust left/right margin/padding and border radius for in-tag matches
              word.style.borderRadius = "0";
              if (m[2][0] == "#") {
                // prefix match (rounded on left)
                word.style.paddingLeft = "4px";
                word.style.marginLeft = "-4px";
                word.style.borderTopLeftRadius;
                word.style.borderTopLeftRadius = "4px";
                word.style.borderBottomLeftRadius = "4px";
              }
              if (text.length == 0) {
                // suffix match (rounded on right)
                word.style.paddingRight = "4px";
                word.style.marginRight = "-4px";
                word.style.borderTopRightRadius = "4px";
                word.style.borderBottomRightRadius = "4px";
              }
            }
          }
        });
        node.nodeValue = text;
      }
    }

    // remove <code></code> wrapper block
    Array.from(itemdiv.getElementsByTagName("code")).forEach((code) => {
      if (code.textContent.startsWith("$") && code.textContent.endsWith("$"))
        code.outerHTML = code.innerHTML;
    });

    // replace <pre></pre> wrapper with <blockquote></blockquote>
    Array.from(itemdiv.getElementsByTagName("pre")).forEach((pre) => {
      if (pre.textContent.startsWith("$") && pre.textContent.endsWith("$"))
        pre.outerHTML = "<blockquote>" + pre.innerHTML + "</blockquote>";
    });

    // capture state for async callback
    // (component state can be modified/reused during callback)
    const typesetdiv = itemdiv;
    const heightdiv = containerdiv;
    const prevheight = height;
    const itemid = id;
    window["MathJax"]
      .typesetPromise([typesetdiv])
      .then(() => {
        typesetdiv
          .querySelectorAll(".MathJax")
          .forEach((elem) => elem.setAttribute("tabindex", "-1"));
        onHeightAsync(itemid, heightdiv.clientHeight, prevheight);
      })
      .catch(console.error);

    // trigger execution of script tags by adding/removing them to <head>
    const scripts = itemdiv.getElementsByTagName("script");
    // wait for all scripts to be done, then cache any cacheable divs
    // (or cache immediately if no scripts to run)
    let pendingScripts = scripts.length;
    if (pendingScripts > 0) {
      console.log(`executing ${pendingScripts} scripts in item ${index} ...`);
      Array.from(scripts).forEach((script) => {
        if (script.parentElement.hasAttribute("_cached")) {
          pendingScripts--;
          console.log("skipping script in cached div");
          return; // skip scripts in restored divs
        }
        script.remove();
        let clone = document.createElement("script");
        clone.type = script.type || "text/javascript";
        clone.id = Math.random().toString();
        // console.log("executing script", script);
        document.head.appendChild(clone);
        clone.onload = function () {
          document.head.removeChild(clone);
          pendingScripts--;
          if (pendingScripts == 0)
            console.log(`all scripts done in item ${index}`);
        };
        if (script.hasAttribute("src")) {
          clone.src = script.src;
        } else {
          clone.innerText = `(function(){${script.innerText}; document.getElementById('${clone.id}').onload()})()`;
        }
      });
    }
  });
</script>

<style>
  .super-container {
    /* break-inside: avoid; */
    margin: 4px 0;
    margin-right: 8px;
    max-width: 800px;
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
    margin-bottom: 4px; /* should match vertical margin of .super-container */
    /* margin-bottom: 4px; */
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
    font-size: 17px;
    line-height: 25px;
    /* cursor: pointer; */
  }
  .saving {
    opacity: 0.5;
  }
  .error {
    color: red;
  }

  /* :global prevents unused css errors and allows matches to elements from other components (see https://svelte.dev/docs#style) */
  .item :global(h1, h2, h3, h4, h5, h6, p, ul, blockquote, pre) {
    margin: 0;
  }
  .item :global(li) {
    text-indent: -3px;
  }
  .item :global(ul) {
    padding-left: 21px;
    /* border-left: 1px solid #333; */
  }
  .item :global(blockquote) {
    padding-left: 15px;
    margin-bottom: 10px;
    border-left: 1px solid #333;
    font-size: 14px;
    line-height: 22px;
  }
  .item :global(pre) {
    padding-left: 15px;
    margin-bottom: 10px;
    border-left: 1px solid #333;
    font-size: 14px;
    line-height: 22px;
  }
  .item :global(code) {
    font-size: 14px;
    line-height: 22px;
    white-space: pre; /* preserve whitespace, break on \n only */
  }
  .item :global(br:last-child) {
    display: none;
  }
  .item :global(a) {
    color: #79e;
    background: #222;
    padding: 1px 4px;
    border-radius: 4px;
    text-decoration: none;
  }
  .item :global(mark) {
    color: black;
    background: #999;
    /* vertical-align: middle; */
    /* remove negative margins used to align with textarea text */
    padding: 1px 4px;
    margin: 0;
  }
  .item :global(mark.selected) {
    background: lightgreen;
  }
  .item :global(mark.secondary-selected) {
    background: white;
    /* background: #333; */
    /* color: lightgreen; */
    /* border: 2px solid lightgreen; */
    /* margin: -2px; */
  }
  .item :global(span.highlight) {
    color: black;
    background: lightgreen;
    border-radius: 4px;
  }
  .item :global(mark span.highlight) {
    color: black;
    background: lightgreen;
    padding: 1px 0;
  }
  .item :global(.vertical-bar) {
    color: #444;
  }
  .item :global(hr) {
    background: transparent;
    border: 0;
    border-top: 1px dashed #222;
    height: 1px; /* disappears if both height and border are 0 */
    margin: 10px 0;
  }
  .item :global(:first-child) {
    margin-top: 0 !important;
  }
  .item :global(:last-child) {
    margin-bottom: 0 !important;
  }
  :global(.MathJax) {
    margin-bottom: 0 !important;
  }
  :global(blockquote .MathJax) {
    display: block;
    padding-top: 5px;
    padding-bottom: 5px;
  }
  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    .item {
      font-size: 16px;
      line-height: 23px;
    }
    .time {
      font-size: 14px;
    }
    .item :global(blockquote) {
      font-size: 12px;
      line-height: 20px;
    }
    .item :global(pre) {
      font-size: 12px;
      line-height: 20px;
    }
    .item :global(code) {
      font-size: 12px;
      line-height: 20px;
    }
  }
</style>

<div class="super-container" bind:this={containerdiv}>
  {#if timeString}
    <div class="time" class:timeOutOfOrder>{timeString}</div>
  {/if}
  <div class="debug">{debugString}</div>
  <div class="container" class:editing class:focused class:timeOutOfOrder>
    <div class="index" class:matching={matchingTerms.length > 0}>
      {#if index == 0}
        <span class="itemCount">{itemCount}</span><br />
        {#if matchingItemCount > 0}
          <span class="matchingItemCount">{matchingItemCount}</span><br />
        {/if}
      {/if}
      {index + 1}
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
      <div
        class="item"
        bind:this={itemdiv}
        class:saving
        class:error
        on:click={onClick}>
        {@html toHTML(text || placeholder, matchingTerms, matchingTermsSecondary)}
      </div>
    {/if}
  </div>
</div>
