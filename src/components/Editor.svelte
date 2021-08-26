<script lang="ts">
  export let id = "editor";
  export let text = "";
  export let focused = false;
  export let showButtons = false;
  export let cancelOnDelete = false;
  export let createOnAnyModifiers = false;
  export let clearOnShiftBackspace = false;
  export let allowCommandCtrlBracket = false;
  // we standardize initial position as 0; can be value.length (e.g. on android)
  // 0 works better for longer items since top of item provides much better context
  export let selectionStart = 0;
  export let selectionEnd = 0;
  export let onFocused = (focused: boolean) => {};
  export let onEdited = (text) => {};
  export let onEscape = (e) => true; // false means handled/ignore
  export let onPastedImage = (url: string, file: File, size_handler = null) => {};
  export let onDone = (text: string, e: any, cancelled: boolean = false, run: boolean = false) => {};
  export let onRun = () => {};
  export let onPrev = () => {};
  export let onNext = () => {};

  import _ from "lodash";
  // import he from "he";
  import { highlight, parseTags, numberWithCommas } from "../util.js";

  const placeholder = " ";
  let spellcheck = false;
  // enable spellcheck iff item contains no blocks (```) and no #_nospell or contains #_spell
  $: spellcheck =
    (!text.match(/(?:^|\n)\s*```\w*(?:$|\n)/) /* no blocks */ && !text.match(/(?:^|\s|\()#_nospell\b/)) ||
    !!text.match(/(?:^|\s|\()#_spell\b/);

  let editor: HTMLDivElement;
  let backdrop: HTMLDivElement;
  let highlights: HTMLDivElement;
  let textarea: HTMLTextAreaElement;

  // NOTE: Highlighting functions are only applied outside of blocks, and only in the order defined here. Ordering matters and conflicts (esp. of misinterpreted delimiters) must be avoided carefully. Tags are matched using a specialized regex that only matches a pre-determined set returned by parseTags that excludes blocks, tags, math, etc. Also we generally can not highlight across lines due to line-by-line parsing of markdown.
  function highlightTags(text, tags) {
    if (tags.length == 0) return text;
    const regexTags = tags.map(_.escapeRegExp).sort((a, b) => b.length - a.length);
    const regex = new RegExp(
      // `(^|[\\s<>&,.;:"'\`(){}\\[\\]])(${regexTags.join("|")})`,
      `(^|\\s|\\()(${regexTags.join("|")})`,
      "g"
    );
    // NOTE: this replacement IGNORES the careful exclusions performed by parseTags (see util.js) other than blocks (e.g. will highlight tags inside html tags that also occur outside of html tags). We fix this below by undoing the replacement in highlightOther.
    return text.replace(regex, "$1<mark>$2</mark>");
  }
  function highlightOther(text) {
    // NOTE: lack of negative lookbehind means we have to match the previous character, which means we require at least one character between an ending delimiter and the start of a new delimiter, e.g. <br><br> or <center></center> would not highlight the second tag; as a workaround, we do not match "><", so adjacent tags are highlighted together
    // https://www.w3schools.com/jsref/jsref_obj_regexp.asp
    // NOTE: asymmetric delimiters (e.g. <<macro>>) are handled first w/ greedy matching (.*) of content to allow outmost delimiters to be matched without interference from potential nesting
    return (
      text
        .replace(
          /(^|[^\\])(\$?\$`|&lt;&lt;|@\{|&lt;script.*?&gt;|&lt;[s]tyle&gt;|&lt;!--|&lt;[/\w])(.*)(`\$\$?|&gt;&gt;|\}@|&lt;\/script&gt;|&lt;\/style&gt;|--&gt;|(?:\w|&#39;|&quot;)&gt;(?:(?!&gt;|&lt;)|$))/g,
          (m, pfx, begin, content, end) => {
            // undo any tag highlighting inside highlighted sections
            content = content.replace(/<mark>(.*?)<\/mark>/g, "$1");
            if ((begin == "$`" && end == "`$") || (begin == "$$`" && end == "`$$"))
              return pfx + `<span class="math">` + highlight(_.unescape(begin + content + end), "latex") + `</span>`;
            else if ((begin == "&lt;&lt;" && end == "&gt;&gt;") || (begin == "@{" && end == "}@"))
              return (
                pfx +
                `<span class="macro"><span class="macro-delimiter">${begin}</span>` +
                highlight(_.unescape(content), "js") +
                `<span class="macro-delimiter">${end}</span></span>`
              );
            else if (begin.match(/&lt;script.*?&gt;/) && end.match(/&lt;\/script&gt;/))
              return (
                pfx +
                highlight(_.unescape(begin), "html") +
                highlight(_.unescape(content), "js") +
                highlight(_.unescape(end), "html")
              );
            else if (begin.match(/&lt;style&gt;/) && end.match(/&lt;\/style&gt;/))
              return (
                pfx +
                highlight(_.unescape(begin), "html") +
                highlight(_.unescape(content), "css") +
                highlight(_.unescape(end), "html")
              );
            else if (
              (begin.match(/&lt;[/\w]/) && end.match(/(?:\w|&#39;|&quot;)&gt;/)) ||
              (begin.match(/&lt;!--/) && end.match(/--&gt;/) && !content.match(/^\s*\/?(?:hidden|removed)\s*$/))
            )
              return pfx + highlight(_.unescape(begin + content + end), "html");
            else return m;
          }
        )
        // NOTE: symmetric delimiters (e.g. `code`) are handled separately w/ _lazy_ matching (.*?) of content
        .replace(/(^|[^\\])(``?)(.*?)(``?)/g, (m, pfx, begin, content, end) => {
          if (begin == end && (begin == "`" || begin == "``"))
            return pfx + `<span class="code">${begin + content + end}</span>`;
          else return m;
        })
    );
  }
  function highlightTitles(text) {
    return text.replace(/^(\s{0,3}#{1,6}\s+)(.+)$/, (_, pfx, title) => pfx + `<span class="title">${title}</span>`);
  }

  function findMatchingOpenParenthesis(text, pos) {
    let close = text[pos];
    let open;
    switch (close) {
      case ")":
        open = "(";
        break;
      case "]":
        open = "[";
        break;
      case "}":
        open = "{";
        break;
    }
    let closed = 1;
    while (closed > 0 && pos >= 0) {
      pos--;
      if (text[pos] == open) closed--;
      else if (text[pos] == close) closed++;
    }
    return pos;
  }

  function findMatchingCloseParenthesis(text, pos) {
    let open = text[pos];
    let close;
    switch (open) {
      case "(":
        close = ")";
        break;
      case "[":
        close = "]";
        break;
      case "{":
        close = "}";
        break;
    }
    let opened = 1;
    while (opened > 0 && pos < text.length) {
      pos++;
      if (text[pos] == close) opened--;
      else if (text[pos] == open) opened++;
    }
    return pos;
  }

  function highlightOpen(text, pos, type) {
    return text.substring(0, pos) + `${text[pos]};{___highlight_open_${type}___}` + text.substring(pos + 1);
  }
  function highlightClose(text, pos, type) {
    return text.substring(0, pos) + `;{___highlight_close_${type}___}${text[pos]}` + text.substring(pos + 1);
  }

  function updateTextDivs() {
    let text = textarea.value || placeholder;

    // pre-highlight matching parentheses using special syntax processed below
    // NOTE: We take care not to break other highlighting with this syntax, but it can be difficult to avoid completely across all languages depending on how they interpret the special syntax. Although we can force "comment" interpration (see util.js) comments can still affect interpretation of surrounding code.
    if (
      textarea.selectionStart == textarea.selectionEnd &&
      textarea.selectionStart > 0 &&
      textarea.selectionStart < text.length &&
      ")]}".includes(text[textarea.selectionStart])
    ) {
      let matchpos = findMatchingOpenParenthesis(text, textarea.selectionStart);
      if (matchpos >= 0) {
        text = highlightClose(text, textarea.selectionStart, "matched");
        text = highlightOpen(text, matchpos, "matched");
      } else {
        text = highlightClose(text, textarea.selectionStart, "unmatched");
      }
    } else if (
      textarea.selectionStart == textarea.selectionEnd &&
      textarea.selectionStart > 0 &&
      textarea.selectionStart < text.length &&
      "([{".includes(text[textarea.selectionStart - 1])
    ) {
      let matchpos = findMatchingCloseParenthesis(text, textarea.selectionStart - 1);
      if (matchpos < text.length) {
        text = highlightClose(text, matchpos, "matched");
        text = highlightOpen(text, textarea.selectionStart - 1, "matched");
      } else {
        text = highlightOpen(text, textarea.selectionStart - 1, "unmatched");
      }
    }

    let insideBlock = false;
    let language = "";
    let code = "";
    let html = "";
    const tags = parseTags(_.unescape(text)).raw;
    text.split("\n").map((line) => {
      if (!insideBlock && line.match(/^\s*```(\w*)$/)) {
        insideBlock = true;
        language = line.match(/^\s*```(\w*)(?:_removed|_hidden|_tmp)?$/)[1];
        code = "";
        html += '<span class="block-delimiter">';
        html += _.escape(line);
        html += "</span>\n";
      } else if (insideBlock && line.match(/^\s*```/)) {
        html += '<div class="block">';
        // drop any underscore (_+) prefix (treated as editor-only highlighting)
        language = language.replace(/^_+/, "");
        html += highlight(code, language);
        html += "</div>";
        insideBlock = false;
        html += '<span class="block-delimiter">';
        html += _.escape(line);
        html += "</span>\n";
      } else if (insideBlock) {
        code += line + "\n";
      } else {
        if (line.match(/^     *[^-*+ ]/)) html += _.escape(line) + "\n";
        else html += highlightTitles(highlightOther(highlightTags(_.escape(line), tags))) + "\n";
      }
    });
    // append unclosed block as regular markdown
    if (insideBlock) html += highlightTitles(highlightOther(highlightTags(_.escape(code), tags)));

    // wrap hidden/removed sections
    html = html.replace(
      /(^|\n\s*?)(&lt;!--\s*?hidden\s*?--&gt;.+?&lt;!--\s*?\/hidden\s*?--&gt;\s*?\n)/gs,
      '$1<div class="section hidden">$2</div>'
    );
    html = html.replace(
      /(^|\n\s*?)(&lt;!--\s*?removed\s*?--&gt;.+?&lt;!--\s*?\/removed\s*?--&gt;\s*?\n)/gs,
      '$1<div class="section removed">$2</div>'
    );
    // indicate section delimiters
    html = html.replace(/(&lt;!--\s*?\/?(?:hidden|removed)\s*?--&gt;)/g, '<span class="section-delimiter">$1</span>');
    // convert open/close parentheses highlight syntax into spans
    // NOTE: we need to allow the parentheses to be wrapped (in other spans) by highlight.js
    html = html.replace(/;{___highlight_close_(\w+?)___}(.*?)([)}\]])/g, '$2<span class="highlight $1">$3</span>');
    html = html.replace(/([({\[])([^({\[]*?);{___highlight_open_(\w+?)___}/g, '<span class="highlight $3">$1</span>$2');
    highlights.innerHTML = html;
    textarea.style.height = editor.style.height = backdrop.scrollHeight + "px";
  }

  export function setSelection(start: number, end: number) {
    const wasFocused = document.activeElement.isSameNode(textarea);
    textarea.selectionStart = start;
    textarea.selectionEnd = end;
    // on Safari, setting the selection can auto-focus so we have to blur
    if (!wasFocused) textarea.blur();
  }

  export function insertImages(create: boolean = false) {
    window["_modal"]({
      content:
        window["_user"].uid == "anonymous"
          ? "Select images to insert. Since you are not signed in, images **will not be uploaded** and will be discarded when you close the page. Once you sign in, all uploads will be encrypted with your secret phrase, viewable **only by you, on your devices.**"
          : "Select images to upload for insertion. Uploads are encrypted with your secret phrase, viewable **only by you, on your devices.**",
      images: true,
      confirm: "Insert Images",
      cancel: "Cancel",
      background: "cancel",
      onCancel: () => {
        textarea.focus();
      },
      onConfirm: (images) => {
        const zoom = Math.round(1000 / window.devicePixelRatio) / 1000;
        const tags = images
          .map((image) => {
            return zoom == 1.0 ? `<img src="${image.fname}">` : `<img src="${image.fname}" style="zoom:${zoom}">`;
          })
          .join(" ");
        textarea.focus();
        document.execCommand("insertText", false, tags);
        onInput();
        if (create) onDone(text, { code: "Enter" });
      },
    });
  }

  import { tick } from "svelte";

  let enterStart = -1;
  let enterIndentation = "";
  let lastKeyDown;
  let lastKeyDownPosition;

  function onKeyDown(e: any) {
    let key = e.code || e.key; // for android compatibility
    // console.debug("Editor.onKeyDown:", e, key);
    lastKeyDown = key;
    lastKeyDownPosition = textarea.selectionStart;

    // ignore modifier keys, and otherwise stop propagation outside of editor
    if (key.match(/^(Meta|Alt|Control|Shift)/)) return;
    else e.stopPropagation();

    // optionally disable Cmd/Ctrl bracket (commonly used as forward/back shortcuts) inside editor
    // TODO: figure out an alternative to this (also for RightArrow/LeftArrow) for iOS15 if necessary
    //       (same issue on MacOS w/ Ctrl+RightArrow/LeftArrow being captured by system unless reconfigured)
    if (!allowCommandCtrlBracket && (key == "BracketLeft" || key == "BracketRight") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      return;
    }

    // disable Shift+Cmd+C which (usually accidentally) enables element targeting in Safari
    if (key == "KeyC" && e.shiftKey && e.metaKey) {
      e.preventDefault();
      return;
    }

    // disable Shift+Cmd/Ctrl+S, letting window handle it for "resume edit"
    if (key == "KeyS" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      return;
    }

    // indent/comment selection or current line
    // NOTE: tab key will indent at bullet heads or when there is a selection
    // NOTE: an alternative is to indent anywhere on a bullet line
    //       (requires taking full current line, not just from current position)
    // const tabShouldIndent =
    //   (textarea.selectionStart == textarea.selectionEnd &&
    //   textarea.value.substring(0, textarea.selectionStart).match(/[-*+] $/)) ||
    //   textarea.selectionEnd > textarea.selectionStart;
    const tabShouldIndent = true; // always indent
    if ((key == "Tab" && tabShouldIndent) || (key == "Slash" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      const oldStart = textarea.selectionStart;
      let oldEnd = textarea.selectionEnd;
      let oldLength = textarea.value.length;
      // move selection to line start
      let lineStart = textarea.value.substring(0, textarea.selectionStart).replace(/[^\n]*$/, "").length;
      textarea.selectionStart = lineStart;
      // expand selection to end of last line
      // if selection ends right after a new line, exclude the last line
      if (textarea.selectionEnd > textarea.selectionStart && textarea.value[textarea.selectionEnd - 1] == "\n")
        textarea.selectionEnd--;
      let lastLineStart = textarea.value.substring(0, textarea.selectionEnd).replace(/[^\n]*$/, "").length;
      let lineEnd =
        lastLineStart +
        textarea.value
          .substring(lastLineStart)
          .match(/^[^\n]*/)[0]
          .trimEnd().length;
      textarea.selectionEnd = lineEnd;

      // NOTE: execCommand maintains undo/redo history
      let selectedText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
      document.execCommand(
        "insertText",
        false,
        key == "Slash"
          ? selectedText.match(/^\s*\/\//) // match(/(^|\n)\s*\/\//)
            ? selectedText.replace(/((?:^|\n)\s*)\/\/\s*/g, "$1")
            : selectedText.replace(/((?:^|\n)\s*)(.*)/g, "$1// $2")
          : key == "Tab" && e.shiftKey
          ? selectedText.replace(/(^|\n)  /g, "$1")
          : selectedText.replace(/(^|\n)/g, "$1  ")
      );

      if (oldStart < oldEnd) {
        // restore expanded selection
        textarea.selectionStart = Math.min(lineStart, oldStart);
        textarea.selectionEnd = oldEnd + (textarea.value.length - oldLength);
      } else {
        // move forward
        textarea.selectionStart = textarea.selectionEnd = Math.max(
          lineStart,
          oldEnd + (textarea.value.length - oldLength)
        );
      }
      onInput();
      return;
    }

    // create item with Cmd/Ctrl+S or Shift/Cmd/Ctrl+Enter
    if (createOnAnyModifiers) {
      if (
        (key == "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) ||
        (key == "KeyS" && (e.metaKey || e.ctrlKey) && !e.shiftKey)
      ) {
        e.preventDefault();
        onDone((text = textarea.value), e, false, key == "Enter" && (e.metaKey || e.ctrlKey) /*run*/);
        return;
      }
    } else {
      if (
        (key == "Enter" && e.shiftKey && !(e.metaKey || e.ctrlKey)) ||
        (key == "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey)) ||
        (key == "KeyS" && (e.metaKey || e.ctrlKey) && !e.shiftKey)
      ) {
        e.preventDefault();
        onDone((text = textarea.value), e, false, key == "Enter" && (e.metaKey || e.ctrlKey) /*run*/);
        return;
      }

      // run item with Alt/Option+Enter
      if (key == "Enter" && e.altKey && !(e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        let selectionStart = textarea.selectionStart;
        let selectionEnd = textarea.selectionEnd;
        onRun();
        tick().then(() => {
          textarea.selectionStart = selectionStart;
          textarea.selectionEnd = selectionEnd;
        });
        return;
      }
    }

    // create line on Enter, maintain indentation
    // NOTE: to prevent delay on caret update, we do the actual indentation in onKeyUp
    if (
      key == "Enter" &&
      !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) &&
      textarea.selectionStart == textarea.selectionEnd
    ) {
      if (enterStart < 0) {
        enterStart = textarea.selectionStart;
        enterIndentation = textarea.value.substring(0, textarea.selectionStart).match(/(?:^|\n)( *).*?$/)[1] || "";
      }
      return;
    }

    if (key == "ArrowUp" && e.metaKey && e.altKey) {
      e.preventDefault();
      onPrev();
      return;
    }
    if (key == "ArrowDown" && e.metaKey && e.altKey) {
      e.preventDefault();
      onNext();
      return;
    }

    // remove spaced tabs (and optional bullet) with backspace
    // (for backspace, unlike shift-tab, we require/allow an _extra_ space and we require even number of spaces)
    const prefix = textarea.value.substring(0, textarea.selectionStart);
    if (
      key == "Backspace" &&
      !(e.shiftKey || e.metaKey || e.ctrlKey) &&
      textarea.selectionStart == textarea.selectionEnd &&
      textarea.selectionStart >= 2 &&
      prefix.match(/(?:^|\s)[-*+ ] $/) &&
      prefix.match(/ *[-*+ ] $/)[0].length % 2 == 0
    ) {
      textarea.selectionStart = textarea.selectionStart - 2;
      // NOTE: forwardDelete seems to behave better on iOS, as "delete" can sometimes cause an additional whitespace to be deleted (e.g. move back to upper bullet in bullet list) for unknown reasons (even only it is not contained in the selection if we comment out the delete)
      document.execCommand("forwardDelete");
      e.preventDefault();
      onInput();
      return;
    }

    // cancel edit with escape
    if (key == "Escape") {
      e.preventDefault();
      if (!onEscape(e)) return; // escape was handled, should be ignored
      onDone(text /* maintain text */, e, true /* cancelled */);
      return;
    }

    // NOTE: this was too easy to trigger accidentally on mobile, so we limit it to search box
    // clear item (from current position to start) with shift-backspace
    if (key == "Backspace" && e.shiftKey && textarea.selectionStart == textarea.selectionEnd) {
      e.preventDefault();
      if (clearOnShiftBackspace) {
        textarea.selectionStart = 0;
        document.execCommand("forwardDelete");
        onInput();
      }
      return;
    }

    // delete non-empty item with Cmd/Ctrl+Backspace
    // NOTE: Cmd-Backspace may be assigned already to "delete line" and overload requires disabling on key down
    if (key == "Backspace" && (e.metaKey || e.ctrlKey)) {
      onDone((text = ""), e, cancelOnDelete); // if cancelled, item will not be deleted
      e.preventDefault();
      return;
    }

    // insert spaces on Tab
    if (key == "Tab" && textarea.selectionStart == textarea.selectionEnd) {
      e.preventDefault();
      if (!e.shiftKey) {
        // forward tab
        document.execCommand("insertText", false, "  ");
      } else if (
        textarea.selectionStart >= 2 &&
        textarea.value.substring(textarea.selectionStart - 2, textarea.selectionStart) == "  "
      ) {
        textarea.selectionStart = textarea.selectionStart - 2;
        document.execCommand("forwardDelete");
      }
      onInput();
      return;
    }

    // insert images on Alt+Cmd+i
    if (key == "KeyI" && e.metaKey && e.shiftKey) {
      e.preventDefault();
      insertImages();
    }
  }

  function onKeyUp(e: any) {
    const key = e.code || e.key; // for android compatibility
    // console.debug("Editor.onKeyUp", e, key);

    // ignore modifier keys, and otherwise stop propagation outside of editor
    if (key.match(/^(Meta|Alt|Control|Shift)/)) return;
    else e.stopPropagation();

    // indent lines created by Enter (based on state recorded in onKeyDown above)
    if (
      key == "Enter" &&
      !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) &&
      textarea.selectionStart == textarea.selectionEnd
    ) {
      if (enterStart >= 0) {
        // extend bullet points to new lines
        const bullet = textarea.value.substring(0, enterStart).match(/(?:^|\n) *([-*+] ).*$/);
        if (bullet) enterIndentation += bullet[1];
        if (enterIndentation) {
          let offset = textarea.value
            .substring(textarea.selectionEnd)
            .match(/^[^\n]*/)[0]
            .trimEnd().length;
          textarea.selectionEnd += offset;
          let newlines = textarea.value.substring(enterStart, textarea.selectionEnd);
          newlines = newlines.replace(/\n([^\n]*)/g, (m, sfx) => {
            let trimmed_sfx = bullet ? sfx.replace(/^[-*+\s]*/, "") : sfx;
            offset -= sfx.length - trimmed_sfx.length;
            return "\n" + enterIndentation + trimmed_sfx;
          });
          textarea.selectionStart = enterStart;
          document.execCommand("insertText", false, newlines);
          textarea.selectionStart = textarea.selectionEnd = textarea.selectionStart - offset;
          onInput();
        }
        enterStart = -1;
        enterIndentation = "";
      }
    }
  }

  function onPaste(e: ClipboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    const data = e.clipboardData || e["originalEvent"].clipboardData;
    // console.debug(Array.from(data.items).map((item: any) => item.type));
    Array.from(data.items).forEach((item: any) => {
      if (item.type == "text/plain") {
        item.getAsString((text) => {
          // copy bullet and indentation to subsequent lines
          let bullet;
          if ((bullet = textarea.value.substring(0, textarea.selectionStart).match(/(?:^|\n)( *)([-*+] +)$/))) {
            text = text.replace(/(^|\n)( *[-*+] +)/g, "$1"); // remove existing bullets
            text = text.replace(/(\n\s*)/g, "$1" + bullet[1] + bullet[2]);
          }
          // replace tabs with double-space
          text = text.replace(/\t/g, "  ");
          document.execCommand("insertText", false, text);
        });
      } else if (item.type.startsWith("image/") || item.type == "application/pdf") {
        const file = item.getAsFile();
        const url = URL.createObjectURL(file);
        const zoom = Math.round(1000 / window.devicePixelRatio) / 1000;
        // document.execCommand("insertText", false, `<img src="${url}" style="zoom:${zoom}">`);
        // // start encrypted upload of pasted image (once done, img src will be replaced in the text)
        // onPastedImage(url, file);
        window["_modal"]({ content: "Inserting pasted image ..." });
        Promise.resolve(
          onPastedImage(url, file, (size) => {
            window["_modal_update"]({
              content: `Inserting pasted image (${numberWithCommas(Math.ceil(size / 1024))} KB) ...`,
            });
          })
        )
          .then((fname) => {
            setTimeout(window["_modal_close"], 0); // increase delay for testing
            const img = zoom == 1.0 ? `<img src="${fname}">` : `<img src="${fname}" style="zoom:${zoom}">`;
            textarea.focus();
            document.execCommand("insertText", false, img);
          })
          .catch(console.error);
      }
    });
  }

  function onInput() {
    // fix for some android keyboard (e.g. GBoard) sending Unidentified for many keys, including Enter
    if (
      lastKeyDown == "Unidentified" &&
      lastKeyDownPosition == textarea.selectionStart - 1 && // exclude backspace
      textarea.selectionStart == textarea.selectionEnd &&
      textarea.value.substring(textarea.selectionStart - 1).startsWith("\n")
    ) {
      const pos = textarea.selectionStart;
      textarea.selectionEnd = textarea.selectionStart = pos - 1;
      onKeyDown({ code: "Enter" });
      textarea.selectionEnd = textarea.selectionStart = pos;
      onKeyUp({ code: "Enter" });
    }

    text = textarea.value; // no trimming until onDone
    updateTextDivs();
    onEdited(textarea.value);
  }

  function onCreate(e) {
    e.stopPropagation();
    e.preventDefault();
    onDone(text, { code: "Enter" });
  }

  function onClear(e) {
    e.stopPropagation();
    e.preventDefault();
    if (textarea.value) {
      if (focused) {
        textarea.selectionStart = 0;
        textarea.selectionEnd = textarea.value.length;
        document.execCommand("forwardDelete");
      } else {
        textarea.value = "";
      }
      onInput();
    }
  }

  function onImage(e) {
    e.stopPropagation();
    e.preventDefault();
    insertImages(!focused); // create new item if not focused
  }

  // function used to cancel click events below
  function cancel(e) {
    e.stopPropagation();
    e.preventDefault();
  }

  import { afterUpdate, onMount, onDestroy } from "svelte";
  afterUpdate(updateTextDivs);

  const highlightDebounceTime = 0;
  let highlightPending = false;
  function onSelectionChange(e) {
    if (!document.activeElement.isSameNode(textarea)) return;
    selectionStart = textarea.selectionStart;
    selectionEnd = textarea.selectionEnd;
    if (textarea.selectionStart != textarea.selectionEnd) return;
    if (highlightPending) return;
    highlightPending = true;
    setTimeout(() => {
      highlightPending = false;
      if (!highlights) return;
      if (
        highlights.querySelector("span.highlight") ||
        (textarea.selectionStart > 0 &&
          textarea.selectionStart < text.length &&
          ")]}".includes(textarea.value[textarea.selectionStart])) ||
        (textarea.selectionStart > 0 &&
          textarea.selectionStart < text.length &&
          "([{".includes(textarea.value[textarea.selectionStart - 1]))
      ) {
        updateTextDivs();
      }
    }, highlightDebounceTime);
  }
  onMount(() => {
    document.addEventListener("selectionchange", onSelectionChange);
    setSelection(selectionStart, selectionEnd);
  });
  onDestroy(() => document.removeEventListener("selectionchange", onSelectionChange));
</script>

<!-- (TODO: remove when svelte plugin is fixed and doesn't break closing textarea tag) -->
<!-- prettier-ignore -->
<div bind:this={editor} class="editor">
  <div class="backdrop" class:focused bind:this={backdrop}>
    <div id="highlights" bind:this={highlights}>{placeholder}</div>
  </div>
  <textarea
    id={"textarea-" + id}
    bind:this={textarea}
    {placeholder}
    on:input={onInput}
    on:keydown={onKeyDown}
    on:keyup={onKeyUp}
    on:paste={onPaste}
    on:focus={() => onFocused((focused = true))}
    on:blur={() => onFocused((focused = false))}
    {spellcheck}
    autocapitalize="off">{text}</textarea>
{#if showButtons}
  <!-- we cancel the click at the parent (.buttons), which works if it doesn't shrink during the click -->
  <div class="buttons" class:focused on:click={cancel}>
    <!-- on:mousedown keeps focus on textarea and generally works better (e.g. allows us to refocus on iOS without going outside of scope of click handler) but we have to cancel subsequent click to avoid side effects (e.g. focus going back to editor after creating a new item) -->
    <div class="button create" on:mousedown={onCreate}>create</div>
    <div class="button image" on:mousedown={onImage}>+img</div>
    <div class="button clear" class:clearable={text.length} on:mousedown={onClear}>clear</div>
  </div>
{/if}
</div>

<!-- update editor on window resize (height changes due to text reflow) -->
<svelte:window on:resize={updateTextDivs} />

<!-- update editor on window resize (height changes due to text reflow) -->
<style>
  .editor {
    position: relative;
    width: 100%;
    cursor: text;
    padding-bottom: 2px; /* covers extra 2px of backdrop (see below), aligns correctly if item has outer border */
  }
  .backdrop,
  textarea {
    font-family: "JetBrains Mono NL", monospace;
    font-weight: 300;
    font-size: 14px;
    line-height: 24px;
    caret-color: red;
  }
  .backdrop {
    /* color: transparent; */
    color: #ddd;
    position: absolute;
    /* top: -1px; */ /* NOTE: backdrop is 2px taller (perhaps due to border) but aligns correctly */
    overflow: hidden;
    width: 100%;
    background: #111;
    width: 100%;
    padding: 10px;
    border-radius: 4px;
    border: 1px dashed #444;
    box-sizing: border-box;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .backdrop.focused {
    background: #171717;
    border: 1px solid #444;
  }
  textarea {
    position: absolute;
    background: transparent;
    color: transparent;
    width: 100%;
    margin: 0;
    padding: 10px;
    outline: none;
    border-radius: 0;
    border: 1px solid transparent;
    overflow: hidden;
    box-sizing: border-box;
    display: block; /* removed additional space below, see https://stackoverflow.com/a/7144960 */
    resize: none;
  }
  .buttons {
    position: absolute;
    top: -30px; /* -15px (touches browser bar), -15 for additional padding */
    right: -2px;
    color: black;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 15px;
    font-weight: 600;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
    border-radius: 5px;
    overflow: hidden;
  }
  .button {
    height: 23px;
    padding: 0 8px;
    padding-top: 15px;
    display: inline-flex;
    background: #999;
    cursor: pointer;
    align-items: center;
  }
  .button:not(:first-child) {
    border-left: 1px solid black;
  }
  .create {
    background: #7a7;
  }
  .clear:not(.clearable) {
    /* NOTE: display: none leaks click on "create" to #header as create button moves right */
    /* display: none; */
    background: #444;
    cursor: not-allowed;
  }
  .buttons:not(.focused) .image {
    display: none;
  }
  /* disable +img for now, seems unnecessary at the top */
  .image {
    display: none;
  }

  :global(mark) {
    /* color: transparent; */
    background: #999;
    font-weight: 600; /* 500 looks light for Menlo w/ white background */
    border-radius: 4px;
    padding: 0 2px;
    margin: 0 -2px;
    cursor: pointer;
  }
  :global(.block) {
    background: rgba(0, 0, 0, 0.5);
    border-radius: 4px;
    padding: 1px;
    margin: -1px;
  }
  :global(.block-delimiter) {
    color: #666;
  }
  :global(.editor .code, .editor .math) {
    background: rgba(0, 0, 0, 0.5);
    padding: 2px 0; /* no overhang since delimited anyway */
    margin: -2px 0;
    border-radius: 4px;
  }
  :global(.editor .macro) {
    background: rgba(0, 0, 0, 0.5);
    border-radius: 4px;
  }
  :global(.editor .macro .macro-delimiter) {
    color: #89bdff; /* same as hljs-tag and also indicative of macroed/scripted/run/etc (blue) */
  }
  :global(.editor .title) {
    padding: 2px 4px;
    margin: -2px -4px;
    background: rgba(255, 255, 255, 0.1);
    /* background: rgba(0, 0, 0, 0.9); */
    border-radius: 4px;
    font-weight: 700;
  }
  :global(.section) {
    border: 1px dashed #444;
    margin: -1px -5px;
    padding: 0 4px;
  }
  :global(.section-delimiter) {
    color: #666;
  }
  :global(span.highlight.matched) {
    color: black;
    background: #9f9;
    border-radius: 4px;
  }
  :global(span.highlight.unmatched) {
    color: black;
    background: #f99;
    border-radius: 4px;
  }
  /* styling for hjls-custom-comment use for highlighting matching parens */
  /* :global(.hljs-comment-custom) {
    display: none;
  } */

  /* adapt to smaller windows/devices */
  @media only screen and (max-width: 600px) {
    .backdrop,
    textarea {
      font-size: 11px;
      line-height: 20px;
    }
  }
</style>
