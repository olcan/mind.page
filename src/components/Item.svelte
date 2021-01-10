<script lang="ts">
  // import _ from "lodash"

  // Markdown library requires import as ESM (ECMAScript module)
  // See https://github.com/markedjs/marked/issues/1692#issuecomment-636596320
  import marked from "marked";
  import {
    highlight,
    extractBlock,
    hashCode,
    regexEscape,
    parseTags,
  } from "../util.js";

  let renderer = new marked.Renderer();
  renderer.link = (href, title, text) => {
    return `<a target="_blank" href="${href}" onclick="event.stopPropagation()">${text}</a>`;
  };
  // marked.use({ renderer });
  marked.setOptions({
    renderer: renderer,
    highlight: highlight,
    langPrefix: "",
  });

  import { Circle, Circle2 } from "svelte-loading-spinners";
  import Editor from "./Editor.svelte";
  export let editing = false;
  export let focused = false;
  export let saving = false;
  export let running = false;
  export let showLogs = false;
  // NOTE: required props should not have default values
  export let index: number;
  export let id: string;
  export let tmpid: string; // temporary id for items created in current session
  export let label: string;
  export let labelUnique: boolean;
  export let missingTags: any;
  export let matchingTerms: any;
  export let matchingTermsSecondary: any;
  export let time: number;
  export let timeString: string;
  export let timeOutOfOrder: boolean;
  export let updateTime: number;
  export let createTime: number;
  export let dotted: boolean;
  export let runnable: boolean;
  export let scripted: boolean;
  export let macroed: boolean;

  export let text: string;
  export let hash: string;
  export let deephash: string;
  export let height = 0;
  const placeholder = " ";
  let error = false;
  let warning = false;
  let target = false;
  let context = false;
  export let onEditing = (
    index: number,
    editing: boolean,
    cancelled: boolean = false,
    run: boolean = false
  ) => {};
  export let onFocused = (index: number, focused: boolean) => {};
  export let onRun = (index: number = -1) => {};
  export let onTouch = (index: number) => {};
  export let onResized = (id, container, trigger: string) => {};
  export let onPrev = () => {};
  export let onNext = () => {};

  let showDebugString = false;
  let debugString;
  // NOTE: the debugString also helps get rid of the "unused property" warning
  $: debugString = `${height} ${time} ${updateTime} ${createTime} ${matchingTerms} ${matchingTermsSecondary}`;

  // cache invalidation function triggered whenever item is run below; this is important since runnable items can have dependencies not included in their cache key (even with deephash)
  function invalidateCache() {
    Object.values(window["_elem_cache"]).filter((elem: HTMLElement) => {
      if (elem.getAttribute("_item") == id) {
        delete window["_elem_cache"][elem.getAttribute("_cache_key")];
        // destroy any c3 charts inside element
        elem.querySelectorAll(".c3").forEach((div) => {
          if (div["_chart"]) {
            div["_chart"].destroy();
            delete div["_chart"];
          }
        });
      }
    });
  }

  function onDone(editorText: string, cancelled: boolean, run: boolean) {
    if (run && !cancelled) invalidateCache();
    onEditing(index, (editing = false), cancelled, run);
  }
  function onClick(e) {
    // ignore clicks on loading div
    if ((e.target as HTMLElement).closest(".loading")) return;
    // console.debug(e.target);
    // ignore (most) clicks inside c3 charts
    if (
      (e.target as HTMLElement).closest(
        ".c3-legend-item-event,.c3-event-rect" // bars can be too small
      ) ||
      ((e.target as HTMLElement).closest(".c3") &&
        (e.target as HTMLElement).style.cursor == "pointer") // click on bars/etc
    ) {
      return;
    }
    if (window.getSelection().type == "Range") return; // ignore click if text is selected
    if (editing) return; // already editing
    onEditing(index, (editing = true));
  }

  function onRunClick(e) {
    if (!runnable) return;
    if (saving || running) return;
    e.stopPropagation();
    e.preventDefault();
    invalidateCache();
    onRun(index);
  }

  function onIndexClick(e) {
    e.stopPropagation();
    e.preventDefault();
    onTouch(index);
  }

  function onSaveClick(e) {
    e.stopPropagation();
    e.preventDefault();
    onEditing(index, (editing = false));
  }

  function onCancelClick(e) {
    e.stopPropagation();
    e.preventDefault();
    onEditing(index, (editing = false), true /* cancelled */);
  }

  function onDeleteClick(e) {
    e.stopPropagation();
    e.preventDefault();
    text = ""; // indicates deletion
    onEditing(index, (editing = false), true /* cancelled */);
  }

  export let onTagClick = (tag: string, reltag: string, e: MouseEvent) => {};
  if (!window["handleTagClick"])
    window["handleTagClick"] = (tag: string, reltag: string, e: MouseEvent) => {
      e.stopPropagation();
      onTagClick(tag, reltag, e);
    };

  export let onLogSummaryClick = (id: string) => {};
  if (!window["handleLogSummaryClick"])
    window["handleLogSummaryClick"] = (id: string, e: MouseEvent) => {
      e.stopPropagation();
      onLogSummaryClick(id);
    };

  if (window["_elem_cache"] == undefined) window["_elem_cache"] = {};
  if (window["_html_cache"] == undefined) window["_html_cache"] = {};

  function toHTML(
    text: string,
    deephash: string,
    labelUnique: boolean,
    // NOTE: passing in arrays has proven problematic (e.g. infinite render loops)
    missingTags: any, // space-separated string converted to Set
    matchingTerms: any, // space-separated string converted to Set
    matchingTermsSecondary: any // space-separated string converted to Set
  ) {
    const cache_key =
      "html-" + hashCode(Array.from(arguments).slice(1).toString());
    if (window["_html_cache"].hasOwnProperty(cache_key)) {
      // console.debug("toHTML skipped");
      return window["_html_cache"][cache_key];
    }
    // console.debug("toHTML");

    matchingTerms = new Set<string>(matchingTerms.split(" ").filter((t) => t));
    matchingTermsSecondary = new Set<string>(
      matchingTermsSecondary.split(" ").filter((t) => t)
    );
    missingTags = new Set<string>(missingTags.split(" ").filter((t) => t));
    if (label) {
      Array.from(matchingTerms).forEach((term: string) => {
        if (
          term[0] == "#" &&
          term.length > label.length &&
          term[label.length] == "/" &&
          term.substring(0, label.length) == label
        )
          matchingTerms.add("#" + term.substring(label.length));
      });
      Array.from(matchingTermsSecondary).forEach((term: string) => {
        if (
          term[0] == "#" &&
          term.length > label.length &&
          term[label.length] == "/" &&
          term.substring(0, label.length) == label
        )
          matchingTermsSecondary.add("#" + term.substring(label.length));
      });
    }

    // remove removed sections
    text = text.replace(
      /<!--\s*removed\s*-->(.*?)<!--\s*\/removed\s*-->\s*?(\n|$)/gs,
      ""
    );

    // extract _log blocks (processed for summary at bottom)
    const log = extractBlock(text, "_log");

    // parse header tags (tags on first line, excluding any styling html)
    const header = text
      .replace(/^<.*>\s+#/, "#")
      .match(/^.*?(?:\n|$)/)[0]
      .toLowerCase();
    const isMenu = parseTags(header).all.indexOf("#menu") >= 0;
    // introduce a line break between any styling html and first tag
    text = text.replace(/^(<.*>)\s+#/, "$1\n#");

    // remove hidden tags (unless missing) and trim
    text = text
      .replace(
        // /(^|\s<>&,.;:"'`(){}\[\]])(#_[^#\s<>&,.;:"'`(){}\[\]]+)/g,
        /(^|\s)(#_[^#\s<>&,.;:"'`(){}\[\]]+)/g,
        (m, pfx, tag) => {
          const lctag = tag.toLowerCase().replace(/^#_/, "#");
          return missingTags.has(lctag) ? pfx + tag : "";
        }
      )
      .trim();

    // parse tags and construct regex for matching
    const tags = parseTags(text).raw;
    if (tags.indexOf("#id") >= 0) console.debug(tags);
    const regexTags = tags.map(regexEscape).sort((a, b) => b.length - a.length);
    const tagRegex = new RegExp(
      // `(^|[\\s<>&,.;:"'\`(){}\\[\\]])(${regexTags.join("|")})`,
      `(^|\\s)(${regexTags.join("|")})`,
      "g"
    );

    // replace naked URLs with markdown links (or images) named after host name
    const replaceURLs = (text) =>
      text.replace(/(^|.?.?)(https?:\/\/[^\s)<]*)/g, (m, pfx, url) => {
        // try to maintain markdown links, html attributes, other url strings, etc
        // NOTE: markdown parser may still convert naked URLs to links
        if (pfx.match(/\]\(|[="'`]/)) return m;
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

    const regexTerms = Array.from(matchingTerms)
      .map(regexEscape)
      .sort((a, b) => b.length - a.length);
    let mathTermRegex = new RegExp(
      `\\$\`.*(?:${regexTerms.join("|")}).*\`\\$`,
      "i"
    );

    // NOTE: modifications should only happen outside of code blocks
    let insideBlock = false;
    let lastLine = "";
    let mathCounts = {};
    let wrapMath = (m) =>
      `<span class="${
        m.startsWith("$$") || !m.startsWith("$") ? "math-display" : "math"
      }" _cache_key="${m}-${(mathCounts[m] =
        (mathCounts[m] || 0) + 1)}">${m}</span>`;
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

        // highlights errors/warnings using console styling even if outside blocks
        // (to be consistent with detection/ordering logic in index.svelte onEditorChange)
        if (!insideBlock && str.match(/^(?:ERROR|WARNING):/)) {
          str = str
            .replace(/^(ERROR:.*)$/, '<span class="console-error">$1</span>')
            .replace(/^(WARNING:.*)$/, '<span class="console-warn">$1</span>');
          console.log(str);
        }

        // preserve inline whitespace and line breaks by inserting &nbsp; and <br>\n outside of code blocks
        // (we miss indented blocks that start with bullets -/* for now since it requires prior-line context)
        // (we exclude /^\s*\|/ to avoid breaking table syntax, which is tricky to match exactly)
        // (we also exclude /^\s*>/ to break inside blockquotes for now)
        // (also note since we process lines, \s does not match \n)
        if (
          !insideBlock &&
          !str.match(/^\s*```|^    \s*[^\-\*]|^\s*<|^\s*>|^\s*\|/)
        ) {
          str = str.replace(/(\S)(\s\s+)/g, (m, pfx, space) => {
            return pfx + space.replace(/  /g, " &nbsp;"); // second space is replaced since ; can be followed by tags
          });
          str = str + "<br>\n";
        }
        // NOTE: sometimes we don't want <br> but we still need an extra \n for markdown parser
        if (!insideBlock && str.match(/^\s*```|^\s*</)) str += "\n";

        // NOTE: for blockquotes (>...) we break lines using double-space
        if (!insideBlock && str.match(/^\s*>/)) str += "  ";
        if (!insideBlock && !str.match(/^\s*```|^    \s*[^\-\*]|^\s*</)) {
          // replace URLs
          str = replaceURLs(str);
          // wrap math inside span.math (unless text matches search terms)
          if (
            matchingTerms.size == 0 ||
            (!str.match(mathTermRegex) && !matchingTerms.has("$"))
          )
            str = str.replace(/\$?\$`.+?`\$\$?/g, wrapMath);
          // style vertical separator bar (│)
          str = str.replace(/│/g, '<span class="vertical-bar">│</span>');
          // wrap #tags inside clickable <mark></mark>
          if (tags.length)
            str = str.replace(tagRegex, (m, pfx, tag) => {
              const lctag = tag.toLowerCase().replace(/^#_/, "#");
              let classNames = "";
              if (matchingTerms.has(lctag)) classNames += " selected";
              else if (matchingTermsSecondary.has(lctag))
                classNames += " secondary-selected";
              if (missingTags.has(lctag)) classNames += " missing";
              if (lctag == label) {
                classNames += " label";
                if (labelUnique) classNames += " unique";
              }
              classNames = classNames.trim();
              if (classNames) classNames = ` class="${classNames}"`;
              let reltag =
                label &&
                tag.length > label.length &&
                tag[label.length] == "/" &&
                tag.substring(0, label.length) == label
                  ? "#" + tag.substring(label.length)
                  : tag;
              return `${pfx}<mark${classNames} onclick="handleTagClick('${tag}','${reltag}',event)">${reltag}</mark>`;
            });
        }
        // close blockquotes with an extra \n before next line
        // NOTE: this does not work for nested blockquotes (e.g. going from  >> to >), which requires counting >s
        if (!insideBlock && lastLine.match(/^\s*>/) && !line.match(/^\s*>/))
          str = "\n" + str;
        lastLine = line;
        return str;
      })
      .join("\n")
      .replace(/\\<br>\n\n/g, "")
      .replace(/<hr(.*?)>\s*<br>/g, "<hr$1>")
      .replace(
        /(^|\n)```_html\w*?\n\s*(.*?)\s*\n```/gs,
        (m, pfx, _html) =>
          (pfx + _html)
            .replace(/\$id/g, tmpid || id)
            .replace(/\$hash/g, hash)
            .replace(/\$deephash/g, deephash)
            .replace(/\n+/g, "\n") // prevents insertion of <br> by marked(text) below
      ); /*unwrap _html* blocks*/

    // hide hidden sections
    text = text.replace(
      /<!--\s*hidden\s*-->(.*?)<!--\s*\/hidden\s*-->\s*?(\n|$)/gs,
      '<div style="display:none">$1</div>'
    );

    // replace special macros <<id|hash|deephash>>
    // NOTE: Special macros are different from $id/$hash/$deephash which are intended for use in scripts and are only replaced inside _html blocks (above), inside js_input blocks (in index.html), or during _read given replace_$id option. These replacements are generally not visible in the rendered item. In contrast, macros are intended to affect the rendered item and are generally not replaced during script execution.
    text = text.replace(/<<id>>/g, tmpid || id);
    text = text.replace(/<<hash>>/g, hash);
    text = text.replace(/<<deephash>>/g, deephash);

    // replace #id.item for use in item-specific css-styles
    // (#$id could also be used inside _html blocks but will break css highlighting)
    text = text.replace(/#id\.item/g, `#${tmpid || id}.item`);

    // evaluate inline <<macros>>
    text = text.replace(/<<(.*?)>>/g, (m, js) => {
      try {
        return window["_eval"](js, tmpid || id);
      } catch (e) {
        console.error(
          `macro error in item ${label || "id:" + (tmpid || id)}: ${e}`
        );
        return undefined;
      }
    });

    // convert markdown to html
    text = marked(text);

    // replace _math blocks, preserving whitespace
    text = text.replace(
      /<pre><code class="_math">(.*?)<\/code><\/pre>/gs,
      (m, _math) => wrapMath(_math)
    );

    // wrap menu items in special .menu class
    if (isMenu) text = '<div class="menu">' + text + "</div>";

    // wrap list items in span to control spacing from bullets
    text = text
      .replace(/<li>/gs, '<li><span class="list-item">')
      .replace(/<\/li>/gs, "</span></li>");

    // process images to transform src and add _cache_key attribute
    text = text.replace(/<img .*?src\s*=\s*"(.+?)".*?>/gi, function (m, src) {
      if (m.match(/_cache_key/i)) {
        console.warn(
          "img with self-assigned _cache_key in item at index",
          index + 1
        );
        return m;
      }
      // convert dropbox image src urls to direct download
      src = src
        .replace("www.dropbox.com", "dl.dropboxusercontent.com")
        .replace("?dl=0", "");
      m = m.replace(/ src=[^> ]*/, "");
      const key = hashCode(m + src).toString(); // cache key includes full tag + src
      // console.debug("img src", src, m);
      return (
        m.substring(0, m.length - 1) + ` src="${src}" _cache_key="${key}">`
      );
    });

    // process divs with item-unique id to add _cache_key="<id>-$deephash" automatically
    text = text.replace(/<div .*?id\s*=\s*"(.+?)".*?>/gi, function (m, divid) {
      if (m.match(/_cache_key/i)) {
        console.warn(
          "div with self-assigned _cache_key in item at index",
          index + 1
        );
        return m;
      }
      if (divid.indexOf(tmpid || id) < 0) {
        console.warn(
          "div without proper id (that includes $id) in item at index",
          index + 1
        );
        return m;
      }
      // m = m.replace(/ _cache_key=[^> ]*/, "");
      // console.debug("img src", src, m);
      const key = divid + "-" + deephash;
      return m.substring(0, m.length - 1) + ` _cache_key="${key}">`;
    });

    // append log summary div
    if (log) {
      const lines = log.split("\n");
      let summary = "";
      lines.forEach((line) => {
        const type = line.match(/^ERROR:/)
          ? "error"
          : line.match(/^WARNING:/)
          ? "warn"
          : line.match(/^INFO:/)
          ? "info"
          : line.match(/^DEBUG:/)
          ? "debug"
          : "log";
        summary += `<span class="console-${type}">·</span>`;
      });
      text += `\n<div class="log-summary" onclick="handleLogSummaryClick('${
        tmpid || id
      }',event)">${summary}</div>`;
    }

    return (window["_html_cache"][cache_key] = text);
  }

  // we use afterUpdate hook to make changes to the DOM after rendering/updates
  let container: HTMLDivElement;
  let itemdiv: HTMLDivElement;
  import { afterUpdate } from "svelte";

  function cacheElems() {
    // cache (restore) elements with attribute _cache_key to (from) window[_cache][_cache_key]
    itemdiv.querySelectorAll("[_cache_key]").forEach((elem) => {
      if (elem.hasAttribute("_cached")) return; // already cached/restored
      const key = elem.getAttribute("_cache_key");
      if (window["_elem_cache"].hasOwnProperty(key)) {
        // console.debug("reusing cached element", key, elem.tagName, elem.id);
        // if (window["_elem_cache"][key].querySelector("script")) console.warn("cached element contains script(s)");
        elem.replaceWith(window["_elem_cache"][key]);
        elem = window["_elem_cache"][key];
        // fix any zero-width c3 charts inside element
        // (can be reset to zero when removed from dom)
        itemdiv.querySelectorAll(".c3 > svg").forEach((svg) => {
          if (svg.getAttribute("width") == "0" && svg.parentElement["_chart"])
            svg.parentElement["_chart"].resize();
        });
        // resize/refresh any c3 charts inside element
        elem.querySelectorAll(".c3").forEach((div) => {
          if (div["_chart"]) div["_chart"].resize();
        });
      } else {
        if (elem.querySelector("script")) return; // contains script; must be cached after script is executed
        elem.setAttribute("_cached", Date.now().toString());
        // console.debug("caching element", key, elem.tagName);
        window["_elem_cache"][key] = elem; //.cloneNode(true);
      }
      elem.setAttribute("_item", id); // for invalidating cached elems on errors
    });
  }

  function renderMath(elems, done = null) {
    if (elems.length == 0) return;
    window["MathJax"]
      .typesetPromise(elems)
      .then(() => {
        const itemdiv = elems[0].closest(".item");
        // NOTE: inTabOrder: false option updates context menu but fails to set tabindex to -1 so we do it here
        itemdiv
          .querySelectorAll(".MathJax")
          .forEach((elem) => elem.setAttribute("tabindex", "-1"));
        if (done) done();
        onResized(id, container, "math rendered");
      })
      .catch(console.error);
  }

  afterUpdate(() => {
    // always report container height for potential changes
    setTimeout(() => onResized(id, container, "afterUpdate"), 0);

    if (!itemdiv) return; // itemdiv is null if editing

    // NOTE: this function must be fast and idempotent, as it can be called multiple times on the same item
    // NOTE: additional invocations can be on an existing DOM element, e.g. one with MathJax typesetting in it
    // NOTE: always invoked twice for new items due to id change after first save
    // NOTE: invoked on every sort, e.g. during search-as-you-type
    // NOTE: empirically, svelte replaces _children_ of itemdiv, so any attributes must be stored on children
    //       (otherwise changes to children, e.g. rendered math, can disappear and not get replaced)

    // insert right-floating div same size as .item-menu, which will also serve as first element of itemdiv
    // NOTE: this is a workaround for a null-parent exception if .item-menu is placed inside .item by Svelte
    if (!editing && itemdiv.firstElementChild?.id != "menu-" + id) {
      let menu = itemdiv.parentElement.querySelector(".item-menu");
      let div = document.createElement("div");
      div.style.width = menu.clientWidth + "px";
      div.style.height = menu.clientHeight + "px";
      /* -10px to remove .item padding, +1px for inset (when .bordered), +1px extra clearing space */
      div.style.marginTop = div.style.marginRight = "-8px";
      div.style.float = "right";
      // div.style.background = "red";
      div.id = "menu-" + id;
      itemdiv.insertBefore(div, itemdiv.firstElementChild);
    }

    if (
      hash == itemdiv.firstElementChild.getAttribute("_hash") &&
      matchingTerms == itemdiv.firstElementChild.getAttribute("_highlightTerms")
    ) {
      // console.debug("afterUpdate skipped");
      // fix any zero-width c3 charts inside element
      // (can be reset to zero during editing if main window loses focus)
      itemdiv.querySelectorAll(".c3 > svg").forEach((svg) => {
        if (svg.getAttribute("width") == "0" && svg.parentElement["_chart"])
          svg.parentElement["_chart"].resize();
      });
      return;
    }
    itemdiv.firstElementChild.setAttribute("_hash", hash);
    itemdiv.firstElementChild.setAttribute("_highlightTerms", matchingTerms);
    // console.debug("afterUpdate");

    // cache any elements with _cache_key (invoked again later for elements with scripts)
    cacheElems();

    // highlight matching terms in item text
    const matchingTermsAtDispatch = matchingTerms;
    let highlightClosure = () => {
      if (!itemdiv) return;
      if (matchingTerms != matchingTermsAtDispatch) return;
      itemdiv.querySelectorAll("span.highlight").forEach((span) => {
        // span.replaceWith(span.firstChild);
        span.outerHTML = span.innerHTML;
      });
      itemdiv.querySelectorAll("mark div").forEach((spacer) => {
        spacer.remove();
      });
      let terms = matchingTerms.split(" ").filter((t) => t);
      if (label) {
        terms.slice().forEach((term: string) => {
          if (
            term[0] == "#" &&
            term.length > label.length &&
            term[label.length] == "/" &&
            term.substring(0, label.length) == label
          )
            terms.push("#" + term.substring(label.length));
        });
      }

      if (terms.length == 0) return;
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
              case "math-display":
              case "script":
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
        let regex = new RegExp(
          `^(.*?)(${terms.map(regexEscape).join("|")})`,
          "si"
        );
        while ((m = text.match(regex))) {
          text = text.slice(m[0].length);
          parent.insertBefore(document.createTextNode(m[1]), node);
          let word = parent.insertBefore(document.createElement("span"), node);
          word.appendChild(document.createTextNode(m[2]));
          word.className = "highlight";
          if (node.parentElement.tagName == "MARK") {
            // NOTE: this becomes stale when the match goes away
            // node.parentElement.style.background = "white";
            // adjust margin/padding and border radius for in-tag (in-mark) matches
            const tagStyle = window.getComputedStyle(node.parentElement);
            word.style.borderRadius = "0";

            // NOTE: marks (i.e. tags) can have varying vertical padding (e.g. under .menu class)
            word.style.paddingTop = tagStyle.paddingTop;
            word.style.marginTop = "-" + word.style.paddingTop;
            word.style.paddingBottom = tagStyle.paddingBottom;
            word.style.marginBottom = "-" + word.style.paddingBottom;
            if (m[2][0] == "#") {
              // prefix match (rounded on left)
              word.style.paddingLeft = tagStyle.paddingLeft;
              word.style.marginLeft = "-" + tagStyle.paddingLeft;
              word.style.borderTopLeftRadius;
              word.style.borderTopLeftRadius = tagStyle.borderTopLeftRadius;
              word.style.borderBottomLeftRadius =
                tagStyle.borderBottomLeftRadius;

              // insert spacer divs under .menu class where mark becomes flexible
              if (node.parentElement.closest(".menu")) {
                let spacer = node.parentElement.insertBefore(
                  document.createElement("div"),
                  node.parentElement.firstChild
                );
                spacer.style.background = "#9c9"; // .item mark span.highlight background
                spacer.style.height = "100%";
                spacer.style.flexGrow = "1";
                spacer.style.paddingLeft = tagStyle.paddingLeft;
                spacer.style.paddingTop = tagStyle.paddingTop;
                spacer.style.paddingBottom = tagStyle.paddingTop;
                spacer.style.marginLeft = "-" + tagStyle.paddingLeft;
                spacer.style.marginTop = "-" + tagStyle.paddingTop;
                spacer.style.marginBottom = "-" + tagStyle.paddingTop;
                spacer.style.borderTopLeftRadius = tagStyle.borderTopLeftRadius;
                spacer.style.borderBottomLeftRadius =
                  tagStyle.borderBottomLeftRadius;
                let rightSpacer = node.parentElement.appendChild(
                  document.createElement("div")
                );
                rightSpacer.style.flexGrow = "1";
              }
            }
            if (text.length == 0) {
              // suffix match (rounded on right)
              word.style.paddingRight = tagStyle.paddingRight;
              word.style.marginRight = "-" + tagStyle.paddingRight;
              word.style.borderTopRightRadius = tagStyle.borderTopLeftRadius;
              word.style.borderBottomRightRadius =
                tagStyle.borderBottomLeftRadius;

              // insert spacer divs under .menu class where mark becomes flexible
              if (node.parentElement.closest(".menu")) {
                let spacer = node.parentElement.appendChild(
                  document.createElement("div")
                );
                spacer.style.background = "#9c9"; // .item mark span.highlight background
                spacer.style.height = "100%";
                spacer.style.flexGrow = "1";
                spacer.style.paddingRight = tagStyle.paddingRight;
                spacer.style.paddingTop = tagStyle.paddingTop;
                spacer.style.paddingBottom = tagStyle.paddingTop;
                spacer.style.marginRight = "-" + tagStyle.paddingRight;
                spacer.style.marginTop = "-" + tagStyle.paddingTop;
                spacer.style.marginBottom = "-" + tagStyle.paddingTop;
                spacer.style.borderTopRightRadius =
                  tagStyle.borderTopRightRadius;
                spacer.style.borderBottomRightRadius =
                  tagStyle.borderBottomRightRadius;
                let leftSpacer = node.parentElement.insertBefore(
                  document.createElement("div"),
                  node.parentElement.firstChild
                );
                leftSpacer.style.flexGrow = "1";
              }
            }
          }
        }
        node.nodeValue = text;
      }
    };
    // highlight menu items immediately, otherwise dispatch
    if (itemdiv.querySelector(".menu")) highlightClosure();
    else setTimeout(highlightClosure, 0);

    // indicate errors in item
    error = itemdiv.querySelector(".console-error,mark.missing") != null;
    warning = itemdiv.querySelector(".console-warn") != null;
    context =
      itemdiv.querySelector("mark.secondary-selected.label.unique") != null;
    target = itemdiv.querySelector("mark.selected.label.unique") != null;

    // trigger typesetting of any math elements
    // NOTE: we do this async to see if we can load MathJax async in template.html
    setTimeout(() => {
      if (!itemdiv) return;
      let math = [];
      itemdiv
        .querySelectorAll("span.math,span.math-display")
        .forEach((elem) => {
          if (elem.hasAttribute("_rendered")) return;
          // console.debug("rendering math", math.innerHTML);
          elem.setAttribute("_rendered", Date.now().toString());
          // unwrap code blocks (should exist for both $``$ and $$``$$)
          let code;
          if ((code = elem.querySelector("code")))
            code.outerHTML = code.innerHTML;
          // insert delimiters if missing (in particular for multi-line _math blocks)
          if (!elem.textContent.match(/^\$.+\$$/)) {
            elem.innerHTML = "$$\n" + elem.innerHTML + "\n$$";
            console.log(elem.textContent);
          }
          math.push(elem);
        });
      renderMath(math);
    });

    // set up img tags to enable caching and invoke onResized onload
    itemdiv.querySelectorAll("img").forEach((img) => {
      if (img.hasAttribute("_loaded")) return; // already loaded (and presumably restored from cache)
      if (!img.hasAttribute("src")) {
        console.warn("img missing src");
        return;
      }
      if (!img.hasAttribute("_cache_key") && !img.src.endsWith("loading.gif")) {
        console.warn("img missing _cache_key (should be automatically added)");
        return;
      }
      img.onload = () => {
        onResized(id, container, "img.onload");
        img.setAttribute("_loaded", Date.now().toString());
      };
    });

    // trigger execution of script tags by adding/removing them to <head>
    // NOTE: this is slow, so we do it asyc, and we warn if the parent element is not cached
    setTimeout(() => {
      if (!itemdiv) return;
      const scripts = itemdiv.querySelectorAll("script");
      // wait for all scripts to be done, then update height in case it changes
      if (scripts.length == 0) return;

      // invalidate cache whenever scripts are run (same as in onDone and onRun)
      // since dependencies are not always fully captured in the cache key (even with deephash)
      invalidateCache();

      let pendingScripts = scripts.length;
      let scriptErrors = [];
      // console.debug(
      //   `executing ${pendingScripts} scripts in item ${index + 1} ...`
      // );
      scripts.forEach((script) => {
        // console.debug(script.parentElement);
        if (
          !script.hasAttribute("_uncached") &&
          !script.parentElement.hasAttribute("_cache_key")
        ) {
          console.warn(
            "script will execute at every render due to uncached parent (missing _cache_key)"
          );
        }
        script.remove(); // remove script to indicate execution
        let clone = document.createElement("script");
        clone.type = script.type || "text/javascript";
        // NOTE: we only support sync embedded scripts for now for simplicity in error handling; if async scripts are needed again in the future, then we need to see if element.onerror works; if so, then we just need to have onload and onerror to invoke the completion logic below (_script_item_id and _errors can be skipped)
        clone.innerHTML = `(function(){\n ${script.innerHTML} \n})()`;

        // NOTE: we track script id which helps with logging and some helper functions, but this only works for sychronous execution; for async scripts tracking requires a context object to be passed around which does not seem worth the trouble for now
        window["_script_item_id"] = id;
        window["_errors"] = [];
        document.head.appendChild(clone);
        document.head.removeChild(clone);
        window["_script_item_id"] = "";
        scriptErrors = scriptErrors.concat(window["_errors"]);

        pendingScripts--;
        if (pendingScripts > 0) return;
        // console.debug(`all scripts done in item ${index + 1}`);
        // if (itemdiv.querySelector("script")) console.warn("item still contains script(s)!");
        setTimeout(() => onResized(id, container, "scripts done"), 0);

        // if no errors, cache elems with _cache_key that had scripts in them
        if (scriptErrors.length > 0) return;
        cacheElems();
        // render new math inside dot graph nodes that may have been rendered by the script
        itemdiv.querySelectorAll(".dot").forEach((dot) => {
          dot["_dotrendered"] = function () {
            // render "stack" clusters (subgraphs)
            dot.querySelectorAll(".cluster.stack").forEach((cluster) => {
              let path = cluster.children[1]; // first child is title
              (path as HTMLElement).setAttribute("fill", "#111");
              let path2 = path.cloneNode();
              (path2 as HTMLElement).setAttribute(
                "transform",
                "translate(-3,3)"
              );
              (path2 as HTMLElement).setAttribute("opacity", "0.75");
              cluster.insertBefore(path2, path);
              let path3 = path.cloneNode();
              (path3 as HTMLElement).setAttribute(
                "transform",
                "translate(-6,6)"
              );
              (path3 as HTMLElement).setAttribute("opacity", "0.5");
              cluster.insertBefore(path3, path2);
            });

            // render math in text nodes
            let math = [];
            dot.querySelectorAll("text").forEach((text) => {
              if (text.textContent.match(/^\$.+\$$/)) {
                text["_bbox"] = (text as SVGGraphicsElement).getBBox(); // needed below
                math.push(text);
              }
            });
            renderMath(math, function () {
              dot
                .querySelectorAll(".node > text > .MathJax > svg > *")
                .forEach((elem) => {
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
                  let scale =
                    (0.6 * textscale * shaperect.height) / mathrect.height;
                  let xt0 = -mathrect.x;
                  let yt0 = -mathrect.y;
                  let xt =
                    shaperect.x +
                    shaperect.width / 2 -
                    (mathrect.width * scale) / 2;
                  let yt =
                    shaperect.y +
                    shaperect.height / 2 +
                    (mathrect.height * scale) / 2;
                  elem.setAttribute(
                    "transform",
                    `translate(${xt},${yt}) scale(${scale},-${scale}) translate(${xt0},${yt0})`
                  );
                });
            });
          };
        });
      });
    }, 0);
  });
</script>

<style>
  .super-container {
    position: relative;
    padding: 4px 0;
  }
  .super-container.editing:not(.timed) {
    padding-top: 24px; /* extra space for .edit-menu */
  }
  .container {
    position: relative;
    border-radius: 5px; /* aligns with editor radius (4px) 1px inside */
    background: #111;
    border: 1px solid #111;
    box-sizing: border-box;
  }
  .item-menu {
    position: absolute;
    top: -1px;
    right: -1px;
    /* background: #333; */
    /* opacity: 0.75; */
    /* NOTE: border-radius causes pixel alignment issues on right edge, so we add rounding to menu items */
    /* border-radius: 0 5px 0 4px; */
    /* overflow: hidden; */
    color: black;
    font-size: 15px;
    font-family: Avenir Next, Helvetica;
    font-weight: 500;
    box-sizing: border-box;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .container.runnable .item-menu > .run {
    border-bottom-left-radius: 5px;
  }
  .container:not(.runnable) .item-menu > .index {
    border-bottom-left-radius: 5px;
  }
  .item-menu > span:last-child {
    border-top-right-radius: 5px;
  }
  .bordered .item-menu {
    top: 0;
    right: 0;
  }
  .bordered .item-menu > span:last-child {
    border-top-right-radius: 4px;
  }

  .edit-menu {
    position: absolute;
    top: -20px;
    right: -1px;
    z-index: 1;
    /* see comment above about issues with border-radius */
    /* border-radius: 4px 6px 4px 4px; */
    /* overflow: hidden; */
    opacity: 1;
    color: black;
    font-family: Avenir Next, Helvetica;
    font-size: 15px;
    font-weight: 500;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .container.runnable .edit-menu > .run {
    border-top-left-radius: 5px;
    border-bottom-left-radius: 5px;
  }
  .container:not(.runnable) .edit-menu > .save {
    border-top-left-radius: 5px;
    border-bottom-left-radius: 5px;
  }
  .edit-menu > span:last-child {
    border-top-right-radius: 5px;
    border-bottom-right-radius: 5px;
  }

  .index,
  .run,
  .delete,
  .cancel,
  .save {
    background: #666;
    display: inline-flex;
    cursor: pointer;
    align-items: center;
    border-right: 1px solid #111;
    height: 25px;
    padding: 0 8px;
  }
  .index {
    padding: 0 4px;
    border: 0;
  }
  .runnable .index,
  .scripted .index,
  .macroed .index {
    background: #468;
  }

  .index.matching {
    background: #9f9;
  }
  .delete {
    /* color: #900; */
    background: #b66;
    /* padding-left: 15px; */
  }
  .run {
    /* color: #0b0; */
    background: #4ae;
  }
  .container:not(.runnable) .run {
    display: none;
  }
  .runnable.running .run,
  .runnable.saving .run {
    /* visibility: false; */
    background: #333;
  }

  .time {
    color: #444;
    display: inline-block;
    padding-left: 5px;
    padding-right: 5px;
    margin-bottom: 4px;
    font-family: Avenir Next, Helvetica;
    font-size: 15px;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .time.timeOutOfOrder {
    color: #aaa;
    background: #111;
    /* color: black; */
    border-radius: 4px;
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
    padding: 10px;
    box-sizing: border-box;
    /* white-space: pre-wrap; */
    word-wrap: break-word;
    font-family: Avenir Next, Helvetica;
    font-size: 18px;
    line-height: 26px;
    /* cursor: pointer; */
    -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
  }

  .context {
    border-left: 1px solid #242;
  }
  .target {
    border-left: 1px solid #484;
  }
  .context,
  .target {
    border-radius: 0 5px 5px 0;
  }
  .context.editing,
  .target.editing {
    border-radius: 5px;
  }
  .warning {
    border: 1px solid #663;
  }
  .error {
    border: 1px solid #633;
  }
  .running {
    /* border: 1px solid #246; */
    border: 1px solid #4af; /* dimmed by .loading */
  }
  /* .item.saving {
    opacity: 0.5;
  } */

  .loading {
    display: flex;
    visibility: hidden;
    position: absolute;
    padding: 1px;
    top: -1px;
    left: -1px;
    width: 100%;
    height: 100%;
    justify-content: center;
    align-items: center;
    background: rgba(0, 0, 0, 0.5);
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
    /* pointer-events: none; */
  }
  .running .loading,
  .saving .loading {
    visibility: visible;
  }

  /* :global prevents unused css errors and allows matches to elements from other components (see https://svelte.dev/docs#style) */
  :global(h1, h2, h3, h4, h5, h6, p, ul, blockquote, pre) {
    margin: 0;
  }
  /* :global(h1, h2, h3, h4, h5, h6) {
    clear: both;
  } */
  :global(.item ul) {
    padding-left: 20px;
  }
  :global(.item span.list-item) {
    display: block;
    margin-left: -5px;
  }
  /* additional space between list items */
  :global(.item ul > li:not(:last-of-type)) {
    padding-bottom: 2px;
  }
  /* reduced space between nested list items */
  :global(.item ul > li ul > li:not(:last-of-type)) {
    padding-bottom: 1px;
  }
  /* additional space below nested lists for inner list items */
  :global(.item li:not(:last-of-type) > ul) {
    padding-bottom: 2px;
  }
  /* add some space before/after lists for more even spacing with surrounding text */
  :global(.item > ul:not(:first-child)) {
    padding-top: 2px;
  }
  :global(.item > ul:not(:last-child)) {
    padding-bottom: 2px;
  }
  /* avoid breaking list items in multi-column items */
  /* NOTE: this turns out to be too performance-intensive and can make columns difficult to balance out */
  /* :global(.item li) {
    break-inside: avoid;
  } */

  /* NOTE: blockquotes (>...) are not monospaced and can keep .item font*/
  :global(.item blockquote) {
    padding-left: 5px;
    margin-top: 5px;
    border-left: 1px solid #333;
  }
  /* NOTE: these font sizes should match those in Editor */
  :global(.item pre) {
    /* padding-left: 5px; */
    /* margin-top: 5px; */
    /* border-left: 1px solid #333; */
    font-size: 15px;
    line-height: 24px;
  }
  :global(.item code) {
    font-size: 15px;
    line-height: 24px;
    white-space: pre-wrap; /* preserve whitespace */
    background: #222;
    padding: 2px 4px;
    border-radius: 4px;
  }
  :global(.item pre code) {
    margin-top: 5px;
    background: none;
    padding: 0;
    border-radius: 0;
  }
  :global(.item a) {
    color: #79e;
    background: #222;
    padding: 0 4px;
    border-radius: 4px;
    text-decoration: none;
  }
  :global(.item mark) {
    color: black;
    background: #999;
    font-weight: 500;
    /* remove negative margins used to align with textarea text */
    padding: 0 4px;
    margin: 0;
  }

  /* .menu styling: paragraphs become flex boxes */
  :global(.item .menu p) {
    display: flex;
    line-height: 24px; /* match image height */
    width: 95%; /* leave some extra space for editing and item count/index indicators */
  }
  :global(.item .menu a),
  :global(.item .menu mark) {
    padding: 4px;
  }
  :global(.item .menu p a, .item .menu p mark) {
    flex: 1 1 auto;
    display: flex;
    justify-content: center;
    align-items: center;
    margin: 2px;
  }
  :global(.item .menu img) {
    width: 24px;
    height: 24px;
    min-width: 24px; /* necessary on smaller device */
    vertical-align: middle;
  }

  :global(.item mark.label) {
    background: #ddd;
  }
  :global(.item mark.label.unique) {
    font-weight: 700;
  }
  :global(.item mark.selected) {
    background: #9f9;
  }
  :global(.item mark.secondary-selected) {
    background: #9c9;
  }
  :global(.item mark.missing) {
    background: #f88;
  }
  :global(.item span.highlight) {
    color: black;
    background: #9f9;
    border-radius: 4px;
  }
  :global(.item mark span.highlight) {
    color: black;
    background: #9c9;
    padding-left: 0;
    padding-right: 0;
  }
  :global(.item mark.label span.highlight) {
    background: #9f9;
  }

  :global(.item .vertical-bar) {
    color: #444;
  }
  :global(.item span.math, .item span.math-display) {
    display: inline-block;
  }
  /* display top-level .math-display as block */
  :global(.item > span.math-display) {
    display: block;
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
    max-height: 100%;
  }
  /* set default size/padding of loading images */
  :global(.item img[src$="loading.gif"]) {
    width: 120px;
    padding: 10px;
  }
  :global(.item :first-child) {
    margin-top: 0;
  }
  :global(.item :last-child) {
    margin-bottom: 0;
  }

  :global(.item ._log) {
    display: none; /* toggled via .showLogs class */
    border-radius: 0 4px 4px 0;
    border-left: 0;
    padding: 4px 0;
    opacity: 0.75;
    font-size: 80%;
    line-height: 150%;
  }
  :global(.container.showLogs .item ._log) {
    display: block;
  }
  :global(.item code:empty) {
    display: block;
    border: 1px dashed #444;
    color: #444;
    padding: 0 4px;
    border-radius: 4px;
  }

  :global(.item code:empty:before) {
    content: "empty " attr(class);
  }

  :global(.item .log-summary) {
    display: flex;
    font-size: 12px;
    font-family: monospace;
    align-items: bottom;
    justify-content: center;
    /* background: red; */
    min-width: 100px;
    height: 25px;
    position: absolute;
    left: 0;
    right: 0;
    bottom: -6px;
    margin-left: auto;
    margin-right: auto;
    padding: 0 8px;
    width: fit-content;
    cursor: pointer;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }

  :global(.item .MathJax) {
    margin-top: 0 !important; /* override some highly specific css */
    margin-bottom: 0 !important;
  }
  :global(.item .math-display) {
    padding-top: 4px;
    padding-bottom: 4px;
  }
  :global(.item > .math-display:first-child) {
    padding-top: 0;
  }
  :global(.item > .math-display:last-child) {
    padding-bottom: 0;
  }

  :global(.item blockquote .MathJax) {
    display: block;
  }
  :global(.item .c3) {
    /* background: #0a0a0a; */
    background: #171717;
    border-radius: 4px;
  }
  :global(.item > .c3:not(:first-child)) {
    margin-top: 4px;
  }
  :global(.item > .c3:not(:last-child)) {
    margin-bottom: 4px;
  }

  /* NOTE: c3 styles are modifications to https://github.com/c3js/c3/blob/master/c3.css */
  :global(path.domain) {
    stroke: gray;
  }
  :global(.tick line),
  :global(.tick text) {
    stroke: gray;
  }
  :global(.c3-legend-item text) {
    stroke: gray;
  }
  :global(.c3-tooltip) {
    -webkit-box-shadow: none;
    -moz-box-shadow: none;
    box-shadow: none;
  }
  :global(.c3-tooltip th),
  :global(.c3-tooltip tr),
  :global(.c3-tooltip td) {
    background-color: #999;
    border: 1px solid #444;
    color: black;
    font-weight: 600;
  }
  :global(.c3-tooltip th) {
    font-weight: 700;
  }
  :global(.c3-grid) {
    opacity: 0.5;
  }
  :global(.c3 text) {
    fill: gray;
    stroke: none;
    font-size: 14px;
    font-family: Avenir Next, Helvetica;
  }
  :global(.c3-line) {
    stroke-width: 3px;
  }

  /* fix an annoying alignment issue where x axis line does not align with bottom tick of y axis */
  :global(.c3-axis-x .domain),
  :global(.c3-axis-x .tick line) {
    transform: translate(0, 0.5pt);
  }

  /* move data labels up on un-rotated charts to accommodate larger point radius */
  :global(.c3:not(.c3-rotated) .c3-text) {
    transform: translate(0, -5px);
  }

  /* rotated chart text adjustments for pixel-perfect alignment with Avenir Next fonts */
  :global(.c3-rotated .c3-axis-x) {
    transform: translate(0, 1px);
  }
  :global(.c3-rotated .c3-texts .c3-text) {
    transform: translate(0, -1px);
  }

  :global(.c3-barchart .c3-axis-x .tick line) {
    display: none;
  }

  :global(.c3-barchart .c3-axis-x .domain) {
    display: none;
  }

  /* NOTE: global CSS for graphviz are not defaults but forced values due to low priority of dot/svg attributes */
  :global(.dot > svg) {
    display: block;
    height: 100%;
    width: auto;
    max-width: 100%;
    margin: auto;
  }
  :global(.dot) {
    padding: 5px 0;
    width: fit-content; /* left-aligns graph assuming it has width:auto */
  }
  :global(.dot .graph text) {
    stroke: none !important;
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
    /* NOTE: these font sizes should match those in Editor */
    :global(.item pre, .item code) {
      font-size: 13px;
      line-height: 21px;
    }
  }
</style>

<div
  class="super-container"
  id={'super-container-' + id}
  class:dotted
  class:editing
  class:timed={timeString.length > 0}>
  {#if timeString}
    <div class="time" class:timeOutOfOrder>{timeString}</div>
  {/if}
  {#if { showDebugString }}
    <div class="debug">{debugString}</div>
  {/if}
  <div
    bind:this={container}
    on:click={onClick}
    class="container"
    class:editing
    class:focused
    class:saving
    class:error
    class:warning
    class:context
    class:target
    class:running
    class:showLogs
    class:bordered={error || warning || running}
    class:runnable
    class:scripted
    class:macroed
    class:timeOutOfOrder>
    {#if editing}
      <div class="edit-menu">
        <span class="run" on:click={onRunClick}>run</span><span
          class="save"
          on:click={onSaveClick}>save</span><span
          class="cancel"
          on:click={onCancelClick}>cancel</span><span
          class="delete"
          on:click={onDeleteClick}>delete</span><span
          class="index"
          class:matching={matchingTerms.length > 0}
          on:click={onIndexClick}>{index + 1}</span>
      </div>

      <Editor
        {id}
        bind:text
        bind:focused
        {onRun}
        {onPrev}
        {onNext}
        onFocused={(focused) => onFocused(index, focused)}
        {onDone} />
    {:else}
      <div class="item-menu">
        <span class="run" on:click={onRunClick}>run</span><span
          class="index"
          class:matching={matchingTerms.length > 0}
          on:click={onIndexClick}>{index + 1}</span>
      </div>
      <!-- NOTE: id for .item can be used to style specific items using #$id selector -->
      <div class="item" {id} bind:this={itemdiv} class:saving>
        <!-- NOTE: arguments to toHTML (e.g. deephash) determine dependencies for (re)rendering -->
        {@html toHTML(text || placeholder, deephash, labelUnique, missingTags, matchingTerms, matchingTermsSecondary)}
      </div>
    {/if}
    {#if running}
      <div class="loading">
        <Circle2 size="40" unit="px" />
      </div>
    {:else if saving}
      <div class="loading">
        <Circle size="25" unit="px" />
      </div>
    {/if}
  </div>
</div>
