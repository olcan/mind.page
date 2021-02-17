<script lang="ts">
  import _ from "lodash";

  // Markdown library requires import as ESM (ECMAScript module)
  // See https://github.com/markedjs/marked/issues/1692#issuecomment-636596320
  import marked from "marked";
  import {
    highlight,
    extractBlock,
    hashCode,
    parseTags,
    renderTag,
    numberWithCommas,
    invalidateElemCache,
  } from "../util.js";

  import { Circle, Circle2 } from "svelte-loading-spinners";
  import Editor from "./Editor.svelte";
  export let editing = false;
  export let focused = false;
  export let saving = false;
  export let running = false;
  export let admin = false;
  export let hidden = false;
  export let showLogs = false;
  // NOTE: required props should not have default values
  export let index: number;
  export let id: string;
  export let label: string;
  export let labelText: string;
  export let labelUnique: boolean;
  export let missingTags: any;
  export let matchingTerms: any;
  export let matchingTermsSecondary: any;
  export let time: number;
  export let timeString: string;
  export let timeOutOfOrder: boolean;
  export let updateTime: number;
  export let createTime: number;
  export let depsString: string;
  export let dependentsString: string;
  export let dotted: boolean;
  export let aboveTheFold: boolean;
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
  export let onEditing = (index: number, editing: boolean, cancelled: boolean = false, run: boolean = false) => {};
  export let onFocused = (index: number, focused: boolean) => {};
  export let onEdited = (index: number, text: string) => {};
  export let onPastedImage = (url: string, file: File, size_handler = null) => {};
  export let onRun = (index: number = -1) => {};
  export let onTouch = (index: number) => {};
  export let onResized = (id, container, trigger: string) => {};
  export let onImageRendering = (src: string) => {};
  export let onImageRendered = (img: HTMLImageElement) => {};
  export let onPrev = () => {};
  export let onNext = () => {};

  let showDebugString = false;
  let debugString;
  // NOTE: the debugString also helps get rid of the "unused property" warning
  $: debugString = `${height} ${time} ${updateTime} ${createTime} ${matchingTerms} ${matchingTermsSecondary}`;

  function onDone(editorText: string, e: KeyboardEvent, cancelled: boolean, run: boolean) {
    if (run && !cancelled) invalidateElemCache(id);
    onEditing(index, (editing = false), cancelled, run);
  }
  function onClick(e) {
    // ignore clicks on loading div
    if ((e.target as HTMLElement).closest(".loading")) return;
    // ignore clicks on inputs
    if (e.target.closest("input")) return;
    // console.debug(e.target);
    // ignore clicks on "clickable" elements
    let clickable = e.target.closest("[_clickable]");
    if (clickable && clickable["_clickable"](e)) return true;
    if (window.getSelection().type == "Range") return; // ignore click if text is selected
    if (editing) return; // already editing
    onEditing(index, (editing = true));
  }

  function onRunClick(e) {
    if (!runnable) return;
    if (saving || running) return;
    e.stopPropagation();
    e.preventDefault();
    invalidateElemCache(id);
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

  let editor;
  function onImageClick(e) {
    e.stopPropagation();
    e.preventDefault();
    editor.insertImages();
  }

  function onDeleteClick(e) {
    e.stopPropagation();
    e.preventDefault();
    text = ""; // indicates deletion
    onEditing(index, (editing = false));
  }

  export let onTagClick = (id: string, tag: string, reltag: string, e: MouseEvent) => {};
  if (!window["handleTagClick"])
    window["handleTagClick"] = (id: string, tag: string, reltag: string, e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault(); // disables handler for onmousedown, prevents change of focus, text selection, etc
      onTagClick(id, tag, reltag, e);
    };

  export let onLinkClick = (id: string, href: string, e: MouseEvent) => {};
  if (!window["handleLinkClick"])
    window["handleLinkClick"] = (id: string, href: string, e: MouseEvent) => {
      e.stopPropagation();
      onLinkClick(id, href, e);
    };

  export let onLogSummaryClick = (id: string) => {};
  if (!window["handleLogSummaryClick"])
    window["handleLogSummaryClick"] = (id: string, e: MouseEvent) => {
      e.stopPropagation();
      onLogSummaryClick(id);
    };

  if (!window["handleDepsSummaryClick"])
    window["handleDepsSummaryClick"] = (id: string, e: MouseEvent) => {
      const div = document.querySelector(`#super-container-${id} .container`);
      if (div) div.classList.toggle("showDeps");
      e.stopPropagation();
    };

  if (!window["handleDependentsSummaryClick"])
    window["handleDependentsSummaryClick"] = (id: string, e: MouseEvent) => {
      const div = document.querySelector(`#super-container-${id} .container`);
      if (div) div.classList.toggle("showDependents");
      e.stopPropagation();
    };

  if (window["_elem_cache"] == undefined) window["_elem_cache"] = {};
  if (window["_html_cache"] == undefined) window["_html_cache"] = {};

  function toHTML(
    text: string,
    id: string,
    deephash: string,
    labelUnique: boolean,
    // NOTE: passing in arrays has proven problematic (e.g. infinite render loops)
    missingTags: any, // space-separated string converted to Set
    matchingTerms: any, // space-separated string converted to Set
    matchingTermsSecondary: any, // space-separated string converted to Set
    depsString: string,
    dependentsString: string
  ) {
    hiddenPendingUpdate = !aboveTheFold; // do not hide above the fold for a more responsive feel

    // NOTE: we exclude text (arg 0) from cache key since it should be captured in deephash
    const cache_key = "html-" + hashCode(Array.from(arguments).slice(1).toString());
    if (window["_html_cache"].hasOwnProperty(cache_key)) {
      // console.debug("toHTML skipped");
      return window["_html_cache"][cache_key];
    }
    // console.debug("toHTML");

    // evaluate inline <<macros>>|@{macros}@ first to ensure treatment just like non-macro content
    let cacheIndex = 0; // counter to distinguish positions of identical cached elements
    let hasMacroErrors = false;
    let macroIndex = 0;
    const replaceMacro = (m, pfx, js) => {
      try {
        js = js.replace(/(^|[^\\])\$id/g, "$1" + id);
        js = js.replace(/(^|[^\\])\$hash/g, "$1" + hash);
        js = js.replace(/(^|[^\\])\$deephash/g, "$1" + deephash);
        js = js.replace(/(^|[^\\])\$pos/g, "$1" + ++cacheIndex); // same cacheIndex for whole macro input
        js = js.replace(/(^|[^\\])\$cid/g, "$1" + `${id}-${deephash}-${cacheIndex}`);
        let out = window["_item"](id).eval(js, { trigger: "macro_" + macroIndex++ });
        // out = out?.replace(/(^|[^\\])\$id/g, "$1" + id);
        // out = out?.replace(/(^|[^\\])\$hash/g, "$1" + hash);
        // out = out?.replace(/(^|[^\\])\$deephash/g, "$1" + deephash);
        // out = out?.replace(/(^|[^\\])\$pos/g, "$1" + ++cacheIndex); // same cacheIndex for whole macro output
        // out = out?.replace(/(^|[^\\])\$cid/g, "$1" + `${id}-${deephash}-${cacheIndex}`);
        // console.debug("macro output: ", out);
        return pfx + out;
      } catch (e) {
        hasMacroErrors = true;
        console.error(`macro error in item ${label || "id:" + id}: ${e}`);
        return pfx + `<span class="macro-error">MACRO ERROR: ${e}</span>`;
      }
    };
    text = text.replace(/(^|[^\\])<<(.*?)>>/g, replaceMacro);
    text = text.replace(/(^|[^\\])@\{(.*?)\}@/g, replaceMacro);

    const firstTerm = matchingTerms ? matchingTerms.match(/^\S+/)[0] : "";
    matchingTerms = new Set<string>(matchingTerms.split(" ").filter((t) => t));
    matchingTermsSecondary = new Set<string>(matchingTermsSecondary.split(" ").filter((t) => t));
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

    // append divs for dependencies and dependents
    function depsStringToHtml(str) {
      return str
        .split(" ")
        .map((dep) => {
          const spanclass = dep.match(/\((.*?)\)$/)?.pop() || "";
          dep = dep.replace(/\(.*?\)$/, "");
          return `<span class="${spanclass}"> ${
            dep.startsWith("#")
              ? dep
              : `<mark onclick="MindBox.toggle('${dep}');handleLinkClick('${id}','javascript:MindBox.toggle(\\'${dep}\\')',event)" title="${dep}">${dep}</mark>`
          } </span>`;
        })
        .join(" ");
    }

    let depsTitle = "";
    let dependentsTitle = "";
    if (depsString || dependentsString) {
      text += `\n<div class="deps-and-dependents">`;
      if (depsString) {
        depsTitle = `${depsString.split(" ").length} dependencies`;
        text += `<span class="deps"><span class="deps-title" onclick="handleDepsSummaryClick('${id}',event)">${depsTitle}</span> ${depsStringToHtml(
          depsString
        )}</span> `;
      }
      if (dependentsString) {
        dependentsTitle = `${dependentsString.split(" ").length} dependents`;
        text += `<span class="dependents"><span class="dependents-title" onclick="handleDependentsSummaryClick('${id}',event)">${dependentsTitle}</span> ${depsStringToHtml(
          dependentsString
        )}</span>`;
      }
      text += "</div>";
    }

    // remove removed sections
    text = text.replace(/<!--\s*removed\s*-->(.*?)<!--\s*\/removed\s*-->\s*?(\n|$)/gs, "");

    // extract _log blocks (processed for summary at bottom)
    const log = extractBlock(text, "_log");

    // introduce a line break between any styling html and first tag
    text = text.replace(/^(<.*>)\s+#/, "$1\n#");

    // parse tags and construct regex for matching
    const tags = parseTags(text).raw;
    const regexTags = tags.map(_.escapeRegExp).sort((a, b) => b.length - a.length);
    // NOTE: this regex (unlike that in Editor or util.js) does not allow preceding '(' because the purpose of that is for to match the href in tag links, which is only visible in the editor, and we want to be generally restrictive when matching tags
    const tagRegex = new RegExp(
      // `(^|[\\s<>&,.;:"'\`(){}\\[\\]])(${regexTags.join("|")})`,
      `(^|\\s)(${regexTags.join("|")})`,
      "g"
    );
    const isMenu = tags.includes("#_menu");

    // replace naked URLs with markdown links (or images) named after host name
    const replaceURLs = (text) =>
      text.replace(/(^|.?.?)(https?:\/\/[^\s)<]*)/g, (m, pfx, url) => {
        // try to maintain markdown links, html attributes, other url strings, etc
        // NOTE: markdown parser may still convert naked URLs to links
        if (pfx.match(/\]\(|[="'`:]$/)) return m; // : can be from generated urls, e.g. blob:http://localhost//...
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
      .map(_.escapeRegExp)
      .sort((a, b) => b.length - a.length);
    let mathTermRegex = new RegExp(`\\$\`.*(?:${regexTerms.join("|")}).*\`\\$`, "i");

    let insideBlock = false;
    let lastLine = "";
    let wrapMath = (m) =>
      `<span class="${
        m.startsWith("$$") || !m.startsWith("$") ? "math-display" : "math"
      }" _cache_key="${m}-${id}-${cacheIndex++}">${m}</span>`;
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
        }

        // preserve line breaks by inserting <br>\n outside of code blocks
        // (we miss indented blocks that start with bullets -/* for now since it requires prior-line context)
        // (we exclude /^\s*\|/ to avoid breaking table syntax, which is tricky to match exactly)
        // (we also exclude /^\s*>/ to break inside blockquotes for now)
        // (also note since we process lines, \s does not match \n)
        if (
          !insideBlock &&
          (str.match(/\\$/) || !str.match(/^\s*```|^    \s*[^-*+]|^\s*---+|^\s*\[[^^].*\]:|^\s*<|^\s*>|^\s*\|/))
        )
          str = str + "<br>\n";

        // NOTE: some lines (e.g. html tag lines) require an extra \n for markdown parser
        if (!insideBlock && str.match(/^\s*```|^\s*</)) str += "\n";

        // NOTE: for blockquotes (>...) we break lines using double-space
        if (!insideBlock && str.match(/^\s*>/)) str += "  ";

        const depline = str.startsWith('<div class="deps-and-dependents">');
        if (!insideBlock && (depline || !str.match(/^\s*```|^    \s*[^\-\*]/))) {
          // wrap math inside span.math (unless text matches search terms)
          if (matchingTerms.size == 0 || (!str.match(mathTermRegex) && !matchingTerms.has("$")))
            str = str.replace(/(^|[^\\])(\$?\$`.+?`\$\$?)/g, (m, pfx, math) =>
              (math.startsWith("$`") && math.endsWith("`$")) || (math.startsWith("$$`") && math.endsWith("`$$"))
                ? pfx + wrapMath(math)
                : m
            );
          // style vertical separator bar (│)
          str = str.replace(/│/g, '<span class="vertical-bar">│</span>');
          // wrap #tags inside clickable <mark></mark>
          if (tags.length)
            str = str.replace(tagRegex, (m, pfx, tag) => {
              // make relative tag absolute
              if (label && tag.startsWith("#/")) tag = labelText + tag.substring(1);
              const lctag = tag.toLowerCase().replace(/^#_/, "#");
              let classNames = "";
              if (matchingTerms.has(lctag)) classNames += " selected";
              else if (matchingTermsSecondary.has(lctag)) classNames += " secondary-selected";
              if (missingTags.has(lctag)) classNames += " missing";
              if (tag.startsWith("#_")) classNames += " hidden";
              if (lctag == label) {
                classNames += " label";
                if (labelUnique) classNames += " unique";
              }
              classNames = classNames.trim();
              // if (depline) classNames = ""; // disable styling for deps/dependents
              if (classNames) classNames = ` class="${classNames}"`;
              let reltag =
                label &&
                tag.length > label.length &&
                tag[label.length] == "/" &&
                tag.substring(0, label.length) == labelText
                  ? "#" + tag.substring(label.length)
                  : tag;
              // shorten selected labels
              if (
                lctag == label &&
                label.includes("/") &&
                labelUnique &&
                (matchingTerms.has(lctag) || matchingTermsSecondary.has(lctag))
              )
                reltag = "#…" + tag.substring(tag.lastIndexOf("/"));
              // shorten prefix-matching labels
              if (
                lctag == label &&
                label.includes("/") &&
                label.length > firstTerm.length &&
                label[firstTerm.length] == "/" &&
                label.substring(0, firstTerm.length) == firstTerm
              )
                reltag = "#…" + tag.substring(firstTerm.length);
              return (
                `${pfx}<mark${classNames} title="${tag}" onmousedown=` +
                `"handleTagClick('${id}','${tag}','${reltag}',event)" onclick="event.preventDefault();event.stopPropagation();">` +
                `${renderTag(reltag)}</mark>`
              );
            });
        }
        // replace URLs (except in lines that look like a reference-style link)
        if (!insideBlock && !str.match(/^\s*\[[^^].*\]:/)) str = replaceURLs(str);

        // break table with extra <br>\n to prevent leading pipe ambiguity (now required) and line-eating
        if (!insideBlock && lastLine.match(/^\s*\|/) && !line.match(/^\s*\|/)) str = "\n" + str;

        // close blockquotes with an extra \n before next line
        // NOTE: this does not work for nested blockquotes (e.g. going from  >> to >), which requires counting >s
        if (!insideBlock && lastLine.match(/^\s*>/) && !line.match(/^\s*>/)) str = "\n" + str;
        lastLine = line;
        return str;
      })
      .join("\n")
      .replace(/\\<br>\n\n/g, "")
      .replace(/<hr(.*?)>\s*<br>/g, "<hr$1>");

    // remove *_removed blocks
    text = text.replace(/(^|\n)```\w*_removed\n\s*(.*?)\s*\n```/gs, (m, pfx) => pfx);

    // hide *_hidden blocks
    text = text.replace(
      /(^|\n)```\w*_hidden\n\s*(.*?)\s*\n```/gs,
      (m, pfx) => "<!--hidden-->\n" + m + "\n<!--/hidden-->"
    );

    // hide hidden sections
    text = text.replace(
      /<!--\s*hidden\s*-->(.*?)<!--\s*\/hidden\s*-->\s*?(\n|$)/gs,
      '<div style="display:none">$1</div>\n'
    );

    // replace #item between style tags for use in item-specific css-styles
    // (#$id could also be used inside _html blocks but will break css highlighting)
    text = text.replace(/(^|[^\\])(<[s]tyle>.*)#item(\W.*<\/style>)/gs, `$1$2#item-${id}$3`);

    // convert markdown to html
    let renderer = new marked.Renderer();
    renderer.link = (href, title, text) => {
      const href_escaped = href.replace(/'/g, "\\'"); // escape single-quotes for argument to handleLinkClick
      const text_escaped = text.replace(/'/g, "\\'"); // escape single-quotes for argument to handleLinkClick
      if (href.startsWith("##")) {
        // fragment link
        const fragment = href.substring(1);
        return `<a href="${fragment}" title="${href}" onclick="handleLinkClick('${id}','${href_escaped}',event)">${text}</a>`;
      } else if (href.startsWith("#")) {
        // tag link
        let tag = href;
        // make relative tag absolute
        if (label && tag.startsWith("#/")) tag = labelText + tag.substring(1);
        const lctag = tag.toLowerCase();
        let classNames = "link";
        if (matchingTerms.has(lctag)) classNames += " selected";
        else if (matchingTermsSecondary.has(lctag)) classNames += " secondary-selected";
        if (missingTags.has(lctag)) classNames += " missing";
        classNames = classNames.trim();
        return `<mark class="${classNames}" title="${tag}" onmousedown="handleTagClick('${id}','${tag}','${text_escaped}',event)" onclick="event.preventDefault();event.stopPropagation();">${text}</mark>`;
      }
      return `<a target="_blank" title="${href}" href="${href}" onclick="handleLinkClick('${id}','${href_escaped}',event)">${text}</a>`;
    };
    // marked.use({ renderer });
    marked.setOptions({
      renderer: renderer,
      highlight: (code, language) => {
        // leave _html(_*) block as is so we don't have to he.decode below
        if (language.match(/^_html(_|$)/)) {
          return code
            .replace(/(^|[^\\])\$id/g, "$1" + id)
            .replace(/(^|[^\\])\$hash/g, "$1" + hash)
            .replace(/(^|[^\\])\$deephash/g, "$1" + deephash)
            .replace(/(^|[^\\])\$pos/g, "$1" + ++cacheIndex) // same cacheIndex for whole _html block
            .replace(/(^|[^\\])\$cid/g, "$1" + `${id}-${deephash}-${cacheIndex}`);
        }
        return highlight(code, language);
      },
      langPrefix: "",
    });
    text = marked(text);

    // unwrap _html(_*) blocks
    text = text.replace(/<pre><code class="_html_?.*?">(.*?)<\/code><\/pre>/gs, (m, _html) => _html);

    // replace _math blocks, preserving whitespace
    text = text.replace(/<pre><code class="_math">(.*?)<\/code><\/pre>/gs, (m, _math) => wrapMath(_math));

    // allow escaping of math and macro delimiters in inline code blocks, used in documenting syntax
    text = text.replace(/(<code>.*?)\\\$`(.*?<\/code>)/g, "$1$$`$2"); // \$`
    text = text.replace(/(<code>.*?)\\\$\$`(.*?<\/code>)/g, "$1$$$$`$2"); // \$$`
    text = text.replace(/(<code>.*?)\\&lt;&lt;(.*?<\/code>)/g, "$1&lt;&lt;$2"); // \<<
    text = text.replace(/(<code>.*?)\\@\{(.*?<\/code>)/g, "$1@{$2"); // \@{

    // wrap menu items in special .menu div, but exclude deps/dependents
    if (isMenu)
      text = '<div class="menu">' + text.replace(/^(.*?)($|<div class="deps-and-dependents">)/s, "$1</div>$2");

    // wrap list items in span to control spacing from bullets
    text = text.replace(/<li>/gs, '<li><span class="list-item">').replace(/<\/li>/gs, "</span></li>");

    // process images to transform src and add _cache_key attribute
    text = text.replace(/<img .*?src\s*=\s*"(.*?)".*?>/gi, function (m, src) {
      if (m.match(/_cache_key/i)) {
        console.warn("img with self-assigned _cache_key in item at index", index + 1);
        return m;
      }
      // convert dropbox image src urls to direct download
      src = src.replace("www.dropbox.com", "dl.dropboxusercontent.com").replace("?dl=0", "");
      m = m.replace(/ src=[^> ]*/, "");
      const key = hashCode(m + src).toString(); // cache key includes full tag + src
      // allow onImageRendering() to change src, and if so, put original as _src and add loading class
      const _src = src;
      src = onImageRendering(src);
      if (src != _src) m = m.substring(0, m.length - 1) + ` _src="${_src}" _loading>`;
      return m.substring(0, m.length - 1) + ` src="${src}" _cache_key="${key}-${id}-${cacheIndex++}">`;
    });

    // process divs with item-unique id to add _cache_key="<id>-$deephash-$pos" automatically
    text = text.replace(/<div .*?id\s*=\s*"(.*?)".*?>/gi, function (m, divid) {
      if (m.match(/_cache_key/i)) {
        console.warn("div with self-assigned _cache_key in item at index", index + 1);
        return m;
      }
      if (!divid.includes(id)) {
        console.warn("div without proper id (that includes $id) in item at index", index + 1);
        return m;
      }
      // m = m.replace(/ _cache_key=[^> ]*/, "");
      // console.debug("img src", src, m);
      const key = divid + "-" + deephash;
      return m.substring(0, m.length - 1) + ` _cache_key="${key}-${cacheIndex++}">`;
    });

    // add onclick handler to html links
    text = text.replace(/<a .*?href\s*=\s*"(.*?)".*?>/gi, function (m, href) {
      if (m.match(/onclick/i)) return m; // link has custom onclick handler
      const href_escaped = href.replace(/'/g, "\\'"); // escape single-quotes for argument to handleLinkClick
      return m.substring(0, m.length - 1) + ` onclick="handleLinkClick('${id}','${href_escaped}',event)">`;
    });

    // append log summary div
    if (log) {
      const lines = log.split("\n");
      let summary = '<span class="log-triangle">▼</span>';
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
        summary += `<span class="log-dot console-${type}">⸱</span>`;
      });
      text += `\n<div class="log-summary" onclick="handleLogSummaryClick('${id}',event)" title="${lines.length} log lines">${summary}</div>`;
    }

    // append dependencies ("deps") summary
    if (depsString) {
      const summary =
        '<span class="deps-triangle">▼</span>' +
        depsString
          .split(" ")
          .map((dep) => `<span class="deps-dot${dep.endsWith("(async)") ? " async" : ""}">⸱</span>`)
          .join("");
      text += `\n<div class="deps-summary" onclick="handleDepsSummaryClick('${id}',event)" title="${depsTitle}">${summary}</div>`;
    }
    // append dependents ("deps") summary
    if (dependentsString) {
      const summary =
        '<span class="dependents-triangle">▼</span>' +
        dependentsString
          .split(" ")
          .map((dep) => `<span class="dependents-dot${dep.endsWith("(visible)") ? " visible" : ""}">⸱</span>`)
          .join("");
      text += `\n<div class="dependents-summary" onclick="handleDependentsSummaryClick('${id}',event)" title="${dependentsTitle}">${summary}</div>`;
    }

    // do not cache with macro errors
    if (hasMacroErrors) return text;
    return (window["_html_cache"][cache_key] = text);
  }

  // we use afterUpdate hook to make changes to the DOM after rendering/updates
  import { afterUpdate } from "svelte";
  let container: HTMLDivElement;
  let itemdiv: HTMLDivElement;

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
        // resize all children w/ _resize attribute (and property)
        elem.querySelectorAll("[_resize]").forEach((e) => e["_resize"]());
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
        if (!itemdiv) return;
        // NOTE: inTabOrder: false option updates context menu but fails to set tabindex to -1 so we do it here
        itemdiv.querySelectorAll(".MathJax").forEach((elem) => elem.setAttribute("tabindex", "-1"));
        if (done) done();
        onResized(id, container, "math rendered");
      })
      .catch(console.error);
  }

  let hiddenPendingUpdate = false;
  let highlightDispatchCount = 0;

  afterUpdate(() => {
    hiddenPendingUpdate = false; // can be set back to true below pending highlights

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

    // we highlight both primary and secondary matching terms
    const highlightTerms = matchingTerms + " " + matchingTermsSecondary;
    if (
      hash == itemdiv.firstElementChild.getAttribute("_hash") &&
      highlightTerms == itemdiv.firstElementChild.getAttribute("_highlightTerms")
    ) {
      // console.debug("afterUpdate skipped");
      // update all children w/ _update attribute (and property)
      // TODO: move this above if disappearing charts continues to be a problem
      //       (actually it may have something to do with opening the web inspector so rule that out)
      itemdiv.querySelectorAll("[_update]").forEach((e) => e["_update"]());
      return;
    }
    itemdiv.firstElementChild.setAttribute("_hash", hash);
    itemdiv.firstElementChild.setAttribute("_highlightTerms", highlightTerms);
    // console.debug("afterUpdate");

    // cache any elements with _cache_key (invoked again later for elements with scripts)
    cacheElems();

    // highlight matching terms in item text
    const mindboxModifiedAtDispatch = window["_mindboxLastModified"];
    const highlightDispatchIndex = highlightDispatchCount++;
    // NOTE: because highlights can be out-of-order, we always highlight priority items
    const maxHighlightsPerTerm = aboveTheFold ? Infinity : Infinity; // no limit for now
    hiddenPendingUpdate = !aboveTheFold;
    // remove previous highlights or related elements
    itemdiv.querySelectorAll("span.highlight").forEach((span: HTMLElement) => {
      // span.replaceWith(span.firstChild); // seems to scale beter
      span.outerHTML = span.innerHTML;
    });
    itemdiv.querySelectorAll("mark div").forEach((spacer) => {
      spacer.remove();
    });
    itemdiv.querySelectorAll("mark.matching").forEach((mark) => {
      mark.classList.remove("matching");
    });

    const highlightClosure = () => {
      if (highlightDispatchIndex != highlightDispatchCount - 1) return; // cancelled due to other dispatch

      // if mindbox was modified recently, postpone up to 500ms
      const timeSinceMindboxModified = Date.now() - window["_mindboxLastModified"];
      if (timeSinceMindboxModified < 500) {
        setTimeout(highlightClosure, 500 - timeSinceMindboxModified);
        return;
      }

      // show item again, but cancel highlights if itemdiv is missing or mindbox modified
      hiddenPendingUpdate = false;
      if (!itemdiv || window["_mindboxLastModified"] != mindboxModifiedAtDispatch) return;

      let terms = highlightTerms.split(" ").filter((t) => t);
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
      let highlight_counts = window["_highlight_counts"];

      let treeWalker = document.createTreeWalker(itemdiv, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: function (node) {
          const classList = (node as HTMLElement).classList;
          switch (node.nodeName.toLowerCase()) {
            case "mark":
              return classList?.contains("selected") || classList?.contains("secondary-selected")
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT;
            case "svg":
            case "script":
              return NodeFilter.FILTER_REJECT;
            default:
              return classList?.contains("c3") ||
                classList?.contains("dot") ||
                classList?.contains("math") ||
                classList?.contains("math-display")
                ? // || classList?.contains("deps-and-dependents")
                  NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT;
          }
        },
      });
      while (treeWalker.nextNode()) {
        const node = treeWalker.currentNode;
        if (node.nodeType != Node.TEXT_NODE) continue;
        const parent = node.parentNode;
        let text = node.nodeValue;
        terms = terms.filter((t) => !(highlight_counts[t] >= maxHighlightsPerTerm));
        if (terms.length == 0) continue; // nothing left to highlight
        let regex = new RegExp(`^(.*?)(${terms.map(_.escapeRegExp).join("|")})`, "si");
        // if we are highlighting inside a non-selected tag, then we expand the regex to allow shortening and rendering adjustments ...
        if (
          node.parentElement.tagName == "MARK" &&
          !node.parentElement.classList.contains("selected") &&
          !node.parentElement.classList.contains("secondary-selected")
        ) {
          let tagTerms = terms
            .concat(highlight_counts["#…"] + highlight_counts["…"] >= maxHighlightsPerTerm ? [] : ["#…"])
            .map(_.escapeRegExp);
          tagTerms = tagTerms.concat(tagTerms.map((t) => t.replace(/^#(.+)$/, "^$1")));
          regex = new RegExp(`(^.*?)(${tagTerms.join("|")})`, "si");
        }
        let m;
        while ((m = text.match(regex))) {
          text = text.slice(m[0].length);
          const term = m[2].toLowerCase();
          const count = highlight_counts[term] || 0;
          if (count >= maxHighlightsPerTerm) continue;
          highlight_counts[term] = count + 1;

          const tagText = node.parentElement?.tagName == "MARK" ? node.parentElement?.innerText : "";
          parent.insertBefore(document.createTextNode(m[1]), node);
          let word = parent.insertBefore(document.createElement("span"), node);
          word.appendChild(document.createTextNode(m[2]));
          word.className = "highlight";

          if (node.parentElement.tagName == "MARK") {
            // ensure tag visible
            node.parentElement.classList.add("matching");
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
            // left/right margin matches span.highlight css
            // word.style.paddingLeft = word.style.paddingRight = "1px";
            // word.style.marginLeft = word.style.marginRight = "-1px";
            const prefixMatch = tagText.lastIndexOf(m[2]) == 0;
            const suffixMatch = text.length == 0;

            if (prefixMatch) {
              // prefix match (rounded on left)
              word.style.paddingLeft = tagStyle.paddingLeft;
              word.style.marginLeft = "-" + tagStyle.paddingLeft;
              word.style.borderTopLeftRadius;
              word.style.borderTopLeftRadius = tagStyle.borderTopLeftRadius;
              word.style.borderBottomLeftRadius = tagStyle.borderBottomLeftRadius;

              // insert spacer divs under .menu class where mark becomes flexible
              if (node.parentElement.closest(".menu")) {
                let spacer = node.parentElement.insertBefore(
                  document.createElement("div"),
                  node.parentElement.firstChild
                );
                spacer.style.background = "#9b9"; // .item mark span.highlight background
                spacer.style.height = "100%";
                spacer.style.flexGrow = "1";
                spacer.style.paddingLeft = tagStyle.paddingLeft;
                spacer.style.paddingTop = tagStyle.paddingTop;
                spacer.style.paddingBottom = tagStyle.paddingTop;
                spacer.style.marginLeft = "-" + tagStyle.paddingLeft;
                spacer.style.marginTop = "-" + tagStyle.paddingTop;
                spacer.style.marginBottom = "-" + tagStyle.paddingTop;
                spacer.style.borderTopLeftRadius = tagStyle.borderTopLeftRadius;
                spacer.style.borderBottomLeftRadius = tagStyle.borderBottomLeftRadius;
                if (!suffixMatch) {
                  let rightSpacer = node.parentElement.appendChild(document.createElement("div"));
                  rightSpacer.classList.add("spacer");
                }
              }
            }
            if (suffixMatch) {
              // suffix match (rounded on right)
              word.style.paddingRight = tagStyle.paddingRight;
              word.style.marginRight = "-" + tagStyle.paddingRight;
              word.style.borderTopRightRadius = tagStyle.borderTopLeftRadius;
              word.style.borderBottomRightRadius = tagStyle.borderBottomLeftRadius;

              // insert spacer divs under .menu class where mark becomes flexible
              if (node.parentElement.closest(".menu")) {
                let spacer = node.parentElement.appendChild(document.createElement("div"));
                spacer.style.background = "#9b9"; // .item mark span.highlight background
                spacer.style.height = "100%";
                spacer.style.flexGrow = "1";
                spacer.style.paddingRight = tagStyle.paddingRight;
                spacer.style.paddingTop = tagStyle.paddingTop;
                spacer.style.paddingBottom = tagStyle.paddingTop;
                spacer.style.marginRight = "-" + tagStyle.paddingRight;
                spacer.style.marginTop = "-" + tagStyle.paddingTop;
                spacer.style.marginBottom = "-" + tagStyle.paddingTop;
                spacer.style.borderTopRightRadius = tagStyle.borderTopRightRadius;
                spacer.style.borderBottomRightRadius = tagStyle.borderBottomRightRadius;
                if (!prefixMatch) {
                  let leftSpacer = node.parentElement.insertBefore(
                    document.createElement("div"),
                    node.parentElement.firstChild
                  );
                  leftSpacer.classList.add("spacer");
                }
              }
            }
          }
        }
        node.nodeValue = text;
      }
    };
    // if (aboveTheFold) highlightClosure();
    // else setTimeout(highlightClosure);
    setTimeout(highlightClosure);

    // indicate errors/warnings and context/target items
    error = itemdiv.querySelector(".console-error,.macro-error,mark.missing") != null;
    warning = itemdiv.querySelector(".console-warn") != null;
    context = itemdiv.querySelector("mark.secondary-selected.label.unique") != null;
    target = itemdiv.querySelector("mark.selected.label.unique") != null;

    // trigger typesetting of any math elements
    // NOTE: we do this async to see if we can load MathJax async in template.html
    setTimeout(() => {
      if (!itemdiv) return;
      let math = [];
      itemdiv.querySelectorAll("span.math,span.math-display").forEach((elem) => {
        if (elem.hasAttribute("_rendered")) return;
        // console.debug("rendering math", math.innerHTML);
        elem.setAttribute("_rendered", Date.now().toString());
        // unwrap code blocks (should exist for both $``$ and $$``$$)
        let code;
        if ((code = elem.querySelector("code"))) code.outerHTML = code.innerHTML;
        // insert delimiters if missing (in particular for multi-line _math blocks)
        if (!elem.textContent.match(/^\$.+\$$/)) {
          elem.innerHTML = "$$\n" + elem.innerHTML + "\n$$";
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
      if (!img.hasAttribute("_cache_key")) {
        console.warn("img missing _cache_key (should be automatically added)");
        return;
      }
      if (img.hasAttribute("_loading")) img.classList.add("loading");
      onImageRendered(img);
      img.onload = () => {
        onResized(id, container, "img.onload");
        img.setAttribute("_loaded", Date.now().toString());
        if (!img.hasAttribute("_loading")) img.classList.remove("loading");
      };
    });

    // turn un-typed inputs into multiple file inputs
    itemdiv.querySelectorAll("input:not([type])").forEach((input: HTMLInputElement) => {
      input.type = "file";
      input.multiple = true;
    });

    // set up file inputs to insert images into item
    // NOTE: only the first file input is accepted and replaces all inputs
    itemdiv.querySelectorAll("input[type=file]").forEach((input: HTMLInputElement) => {
      input.accept = "image/*"; // accept only images
      input.onchange = function (e: InputEvent) {
        window["_modal"]({ content: "Inserting selected images ..." });
        let total_size = 0;
        Promise.all(
          Array.from(input.files).map((file) =>
            Promise.resolve(
              onPastedImage(URL.createObjectURL(file), file, (size) => {
                total_size += size;
                window["_update_modal"]({
                  content: `Inserting selected images (${numberWithCommas(Math.ceil(total_size / 1024))} KB) ...`,
                });
              })
            )
          )
        )
          .then((fnames: any) => {
            setTimeout(window["_close_modal"], 0); // increase delay for testing
            const zoom = Math.round(1000 / window.devicePixelRatio) / 1000;
            const images = fnames
              .map((fname) => {
                return zoom == 1.0 ? `<img src="${fname}">` : `<img src="${fname}" style="zoom:${zoom}">`;
              })
              .join("\n");
            let item = window["_item"](id);
            let text = item.read();
            text = text.replace(/<input .*?type\s*=\s*["']?file.*?>|<input>/gi, images);
            item.write(text, "" /* replace whole item*/);
          })
          .catch(console.error);
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
      invalidateElemCache(id);

      let pendingScripts = scripts.length;
      let scriptErrors = [];
      // console.debug(
      //   `executing ${pendingScripts} scripts in item ${index + 1} ...`
      // );
      scripts.forEach((script, scriptIndex) => {
        // console.debug(script.parentElement);
        if (!script.hasAttribute("_uncached") && !script.parentElement.hasAttribute("_cache_key")) {
          console.warn("script will execute at every render due to uncached parent (missing _cache_key)");
        }
        script.remove(); // remove script to indicate execution
        // NOTE: we do not support .src yet, when we do we need to fetch the script using AJAX, prefix w/ __id, and ensure proper completion/error handling via script.onerror assuming that works.
        if (script.hasAttribute("src")) {
          console.error("script src not supported yet");
        } else {
          try {
            window["_item"](id).eval(script.innerHTML, { trigger: "script_" + scriptIndex });
          } catch (e) {
            console.error(`<script> error in item ${label || "id:" + id}: ${e}`);
            scriptErrors.push(e);
          }
        }

        pendingScripts--;
        if (pendingScripts > 0) return;
        // console.debug(`all scripts done in item ${index + 1}`);
        setTimeout(() => onResized(id, container, "scripts done"), 0);
        // if no errors, cache elems with _cache_key that had scripts in them
        if (scriptErrors.length == 0) cacheElems();

        // if element contains dot graphs, they may trigger window._dot_rendered, defined below
      });
    });
  });

  if (!window["_dot_rendered"]) {
    window["_dot_rendered"] = function (dot) {
      // render "stack" clusters (subgraphs)
      dot.querySelectorAll(".cluster.stack").forEach((cluster) => {
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
      dot.querySelectorAll("text").forEach((text) => {
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
          elem.setAttribute("transform", `translate(${xt},${yt}) scale(${scale},-${scale}) translate(${xt0},${yt0})`);
        });
      });
    };
  }
</script>

<div
  class="super-container"
  id={"super-container-" + id}
  class:dotted
  class:editing
  class:hidden
  class:hiddenPendingUpdate
  class:timed={timeString.length > 0}
>
  {#if timeString}
    <div class="time" class:timeOutOfOrder>{timeString}</div>
  {/if}
  {#if showDebugString}
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
    class:admin
    class:showLogs
    class:bordered={error || warning || running}
    class:runnable
    class:scripted
    class:macroed
    class:timeOutOfOrder
  >
    {#if editing}
      <div class="edit-menu">
        <div class="run" on:click={onRunClick}>run</div>
        <div class="save" on:click={onSaveClick}>save</div>
        <div class="image" on:click={onImageClick}>+img</div>
        <div class="cancel" on:click={onCancelClick}>cancel</div>
        <div class="delete" on:click={onDeleteClick}>delete</div>
        <div class="index" class:matching={matchingTerms.length > 0} on:click={onIndexClick}>{index + 1}</div>
      </div>

      <Editor
        {id}
        bind:this={editor}
        bind:text
        bind:focused
        {onRun}
        {onPrev}
        {onNext}
        onFocused={(focused) => onFocused(index, focused)}
        onEdited={(text) => onEdited(index, text)}
        {onPastedImage}
        {onDone}
      />
    {:else}
      <div class="item-menu">
        <span class="run" on:click={onRunClick}>run</span><span
          class="index"
          class:matching={matchingTerms.length > 0}
          on:click={onIndexClick}>{index + 1}</span
        >
      </div>
      <!-- NOTE: id for .item can be used to style specific items using #$id selector -->
      <div class="item" id={"item-" + id} bind:this={itemdiv} class:saving>
        <!-- NOTE: arguments to toHTML (e.g. deephash) determine dependencies for (re)rendering -->
        {@html toHTML(
          text || placeholder,
          id,
          deephash,
          labelUnique,
          missingTags,
          matchingTerms,
          matchingTermsSecondary,
          depsString,
          dependentsString
        )}
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

<style>
  .super-container {
    position: relative;
    padding: 4px 0;
    padding-left: 1px; /* avoid touching window border, looks better on the mac */
  }
  .super-container.editing:not(.timed) {
    padding-top: 24px; /* extra space for .edit-menu */
  }
  .hidden,
  .hiddenPendingUpdate,
  /* hiding ALL items below any pending-update items is important to avoid expensive layout updates */
  :global(.hiddenPendingUpdate ~ .super-container) {
    position: absolute;
    right: -100000px; /* off-screen to avoid any interactions */
    width: 100%;
  }

  .container {
    position: relative;
    border-radius: 5px; /* aligns with editor radius (4px) 1px inside */
    background: #111;
    border: 1px solid #111;
    box-sizing: border-box;
  }
  .admin {
    border: 1px dashed #444;
  }
  .item-menu {
    display: flex;
    position: absolute;
    top: -1px;
    right: -1px;
    /* background: #333; */
    opacity: 0.5;
    /* NOTE: border-radius causes pixel alignment issues on right edge, so we add rounding to menu items */
    /* border-radius: 0 5px 0 4px; */
    /* overflow: hidden; */
    color: black;
    font-size: 15px;
    font-weight: 600;
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
    display: flex;
    position: absolute;
    top: -20px;
    right: -1px;
    z-index: 1;
    /* see comment above about issues with border-radius */
    /* border-radius: 4px 6px 4px 4px; */
    /* overflow: hidden; */
    opacity: 1;
    color: black;
    font-size: 15px;
    font-weight: 600;
    border-radius: 5px;
    overflow: hidden;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }

  .run,
  .save,
  .image,
  .cancel,
  .delete,
  .index {
    background: #666;
    display: inline-flex;
    cursor: pointer;
    align-items: center;
    border-right: 1px solid black;
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
  .save {
    background: #7a7;
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
    height: 20px; /* fixed height (=24 including margin-bottom) */
    color: #444;
    display: inline-block;
    padding-left: 5px;
    padding-right: 5px;
    margin-bottom: 4px;
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
  }
  .item {
    color: #ddd;
    width: 100%;
    min-height: 48px; /* single line height */
    padding: 10px;
    box-sizing: border-box;
    /* white-space: pre-wrap; */
    word-wrap: break-word;
    font-size: 18px;
    line-height: 28px;
    /* cursor: pointer; */
    -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
    /* clear floats (e.g. deps, dependents) */
    /* this causes scrolling for popups */
    /* overflow: auto; */
  }

  .context {
    border-left-color: #242;
  }
  .target {
    border-color: #484;
  }
  .context {
    border-radius: 0 5px 5px 0;
  }
  .context.editing {
    border-radius: 5px;
  }
  .warning {
    border-color: #663;
  }
  .error {
    border-color: #633;
  }
  .running {
    /* border-color: #246; */
    border-color: #4af; /* dimmed by .loading */
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
  :global(h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, pre) {
    margin: 0;
  }
  /* :global(h1, h2, h3, h4, h5, h6) {
    clear: both;
  } */
  :global(.item ul),
  :global(.item ol) {
    padding-left: 20px;
    color: #666;
  }
  :global(.item span.list-item) {
    display: block;
    margin-left: -5px;
    color: #ddd;
  }
  /* additional space between list items */
  :global(.item ul > li:not(:last-of-type)),
  :global(.item ol > li:not(:last-of-type)) {
    padding-bottom: 2px;
  }
  /* reduced space between nested list items */
  :global(.item ul > li ul > li:not(:last-of-type)),
  :global(.item ol > li ol > li:not(:last-of-type)) {
    padding-bottom: 1px;
  }
  /* additional space below nested lists for inner list items */
  :global(.item li:not(:last-of-type) > ul),
  :global(.item li:not(:last-of-type) > ol) {
    padding-bottom: 2px;
  }
  /* add some space before/after lists for more even spacing with surrounding text */
  :global(.item > ul:not(:first-child)),
  :global(.item > ol:not(:first-child)) {
    padding-top: 2px;
  }
  :global(.item > ul:not(:last-child)),
  :global(.item > ol:not(:first-child)) {
    padding-bottom: 2px;
  }
  /* avoid breaking list items in multi-column items */
  /* NOTE: this turns out to be too performance-intensive and can make columns difficult to balance out */
  /* :global(.item li) {
    break-inside: avoid;
  } */

  /* column spacing for tables */
  :global(.item table) {
    border-spacing: 10px 0;
    border-collapse: separate;
    margin-left: -10px;
  }
  :global(.item table td) {
    vertical-align: top;
  }

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
    margin-top: 4px;
  }
  :global(.item pre:first-child) {
    margin-top: 0;
  }
  :global(.item code) {
    font-size: 15px;
    line-height: 24px;
    font-family: "Source Code Pro", monospace;
    font-weight: 500;
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
  :global(.item pre > code) {
    display: block;
    /* background: #171717; */
    /* border-radius: 4px; */
    padding: 2px 5px;
    margin: -2px -5px;
    border-left: 1px solid #333;
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
    font-weight: 600;
    padding: 0 4px;
    margin: 0;
  }

  /* .menu styling: paragraphs become flex boxes */
  :global(.item .menu p) {
    display: flex;
    line-height: 26px; /* match image height */
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
    font-weight: 900;
  }
  :global(.item mark.missing) {
    background: #f88;
  }
  :global(.item mark.selected) {
    background: #9f9;
  }
  :global(.item mark.secondary-selected) {
    background: #9b9;
  }

  :global(.item mark.hidden) {
    color: #ddd;
    background: #222;
    border: 1px dashed #ddd;
  }
  :global(.item mark.hidden:not(.matching, .missing, .selected, .secondary-selected)) {
    display: none;
  }
  :global(.item br:last-child) {
    display: none;
  }
  :global(.item blockquote br:last-child) {
    display: block;
  }

  :global(.item mark.hidden.missing) {
    border-color: #f88;
  }
  :global(.item mark.hidden.selected) {
    border-color: #9f9;
  }
  :global(.item mark.hidden.secondary-selected) {
    border-color: #9b9;
  }

  :global(.item span.highlight) {
    /* color: black; */
    /* background: #9f9; */
    border: 1px solid #9b9;
    border-radius: 4px;
    /* font-weight: 600; */
    /* NOTE: we do not pad highlights as it can overlap non-highlighted text */
    margin: -1px;
  }
  :global(.item mark.label.unique span.highlight) {
    font-weight: 900; /* match weight of mark.label.unique */
  }

  :global(.item mark span.highlight) {
    color: black;
    background: #9b9;
    border: 0;
    margin: 0;
  }
  :global(.item mark.label span.highlight) {
    background: #9f9;
  }

  :global(.item mark .spacer) {
    flex-grow: 1;
  }
  /* disable spacers inside .menu highlights when prefix and suffix matches coincide */
  :global(.item .menu mark .spacer:nth-last-of-type(4)),
  :global(.item .menu mark .spacer:nth-last-child(2)) {
    display: none;
  }

  :global(.item .vertical-bar) {
    color: #444;
  }
  :global(.item span.math, .item span.math-display) {
    display: inline-block;
  }
  /* display top-level .math-display as block */
  /* :global(.item > span.math-display) {
    display: block;
  } */
  :global(.item hr) {
    background: transparent;
    border: 0;
    border-top: 1px dashed #333;
    height: 1px; /* disappears if both height and border are 0 */
    margin: 10px 0;
    clear: both; /* clear floats on both sides by default */
  }
  :global(.item img) {
    max-width: 100%;
    max-height: 100%;
    vertical-align: middle;
  }
  /* set default size/padding of loading images */
  :global(.item img.loading),
  :global(.item img[_loading]) {
    width: 32px;
    height: 32px;
    border: 1px dashed #999;
    border-radius: 50%;
  }
  :global(.item :first-child) {
    margin-top: 0;
  }
  :global(.item :last-child) {
    margin-bottom: 0;
  }

  :global(.item ._log) {
    display: none; /* toggled via .showLogs class */
    opacity: 0.75;
    font-size: 80%;
    line-height: 160%;
  }
  :global(.container.showLogs .item ._log),
  :global(.container.showLogs .item .log-triangle) {
    display: block;
  }
  :global(.container.showLogs .item .log-dot) {
    display: none;
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

  :global(.item .log-summary),
  :global(.item .deps-summary),
  :global(.item .dependents-summary) {
    display: flex;
    font-size: 12px;
    font-family: "Source Code Pro", monospace;
    font-weight: 500;
    align-items: bottom;
    justify-content: center;
    /* background: red; */
    min-width: 100px;
    max-width: 50%;
    overflow: hidden;
    height: 25px;
    position: absolute;
    left: 0;
    right: 0;
    /* 3px left padding aligns best with code block left border on iOS Safari */
    padding: 0 3px;
    bottom: -7px; /* 3px remaining */
    margin-left: auto;
    margin-right: auto;
    width: fit-content;
    cursor: pointer;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }

  /* increase left/right padding on non-iOS mac due to ~1px less padding of monospace characters */
  @supports not (-webkit-touch-callout: none) {
    :global(.item .log-summary),
    :global(.item .deps-summary),
    :global(.item .dependents-summary) {
      padding: 0 4px;
      bottom: -6px; /* 4px remaining */
    }
  }

  :global(.item .log-summary) {
    display: flex;
    justify-content: flex-start;
    max-width: 25%;
    right: auto;
    padding-right: 0;
    margin: 0;
  }
  :global(.item .dependents-summary) {
    display: flex;
    justify-content: flex-end;
    max-width: 25%;
    left: auto;
    padding-left: 0;
    margin: 0;
  }

  :global(.item .deps-dot) {
    color: #666;
  }
  :global(.item .deps-dot.async) {
    color: #999;
  }
  :global(.item .dependents-dot) {
    color: #555;
  }
  :global(.item .dependents-dot.visible) {
    color: #999;
  }
  :global(.item .log-triangle),
  :global(.item .deps-triangle),
  :global(.item .dependents-triangle) {
    display: none;
    font-size: 10px;
    color: #999;
  }

  :global(.item .deps-dot) {
    margin-right: 1px;
  }

  /* increase dot margins on non-iOS due to ~1px less padding of monospace characters */
  @supports not (-webkit-touch-callout: none) {
    :global(.item .log-dot) {
      margin-right: 2px;
    }
    :global(.item .deps-dot) {
      margin: 0 1px;
    }
    :global(.item .dependents-dot) {
      margin-left: 1px;
    }
  }

  :global(.item .deps-and-dependents) {
    display: none;
    font-size: 80%;
    line-height: 160%;
    /* white-space: nowrap; */
    padding-top: 10px;
    padding-bottom: 7px; /* avoid overlap with summaries */
  }
  /* we apply negative margin only when direct child, e.g. for when a multi-column macro is left open */
  :global(.item > .deps-and-dependents) {
    margin-left: -6px;
  }
  :global(.container.showDeps .item .deps-and-dependents),
  :global(.container.showDependents .item .deps-and-dependents) {
    display: block;
  }
  :global(.item .deps-and-dependents .deps),
  :global(.item .deps-and-dependents .dependents) {
    display: none;
  }
  :global(.container.showDeps .item .deps-and-dependents .deps),
  :global(.container.showDeps .item .deps-triangle),
  :global(.container.showDependents .item .deps-and-dependents .dependents),
  :global(.container.showDependents .item .dependents-triangle) {
    display: inline;
  }

  :global(.container.showDeps .item .deps-dot),
  :global(.container.showDependents .item .dependents-dot) {
    display: none;
  }

  :global(.item .deps-and-dependents mark),
  :global(.item .deps-and-dependents a) {
    opacity: 0.75;
  }
  :global(.item .deps-and-dependents span.visible mark),
  :global(.item .deps-and-dependents span.async mark) {
    opacity: 1;
  }
  :global(.item .deps-and-dependents span.visible a),
  :global(.item .deps-and-dependents span.async a) {
    opacity: 1;
  }

  :global(.item .deps-and-dependents .deps-title),
  :global(.item .deps-and-dependents .dependents-title) {
    color: black;
    background: #bbb;
    font-weight: 600;

    /* border: 1px solid #999; */
    padding: 0 4px;
    border-radius: 4px 0 0 4px;
    white-space: nowrap;
    cursor: pointer;
  }

  :global(.item span.macro-error) {
    color: black;
    background: #f55;
    border-radius: 4px;
    font-weight: 600;
    padding: 0 4px;
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

  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    .super-container {
      padding-left: 0; /* assume no border issue, maximize space use */
    }
    .item {
      font-size: 16px;
      line-height: 25px;
      min-height: 45px; /* single line height */
    }
    /* NOTE: these font sizes should match those in Editor */
    :global(.item pre, .item code) {
      font-size: 13px;
      line-height: 23px;
    }
  }
</style>
